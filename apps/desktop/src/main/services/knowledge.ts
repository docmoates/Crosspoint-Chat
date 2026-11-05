import type { KnowledgeCard, KnowledgeFact } from '@shared/ipc'
import { extractEntityQuery } from '@shared/entity-query'
import type { DB } from '../db'

const WIKIPEDIA = 'https://en.wikipedia.org'
const WIKIDATA = 'https://www.wikidata.org'
const TIMEOUT_MS = 6000
const CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MISS_TTL_MS = 24 * 60 * 60 * 1000
const MAX_THUMB_BYTES = 400_000
const MAX_FACTS = 14
const MIN_SCORE = 0.6

export interface KnowledgeCache {
  get(key: string): { json: string; fetchedAt: number } | undefined
  set(key: string, json: string): void
}

export class MemoryKnowledgeCache implements KnowledgeCache {
  private readonly map = new Map<string, { json: string; fetchedAt: number }>()
  get(key: string): { json: string; fetchedAt: number } | undefined {
    return this.map.get(key)
  }
  set(key: string, json: string): void {
    this.map.set(key, { json, fetchedAt: Date.now() })
  }
}

export class SqliteKnowledgeCache implements KnowledgeCache {
  constructor(private readonly db: DB) {}
  get(key: string): { json: string; fetchedAt: number } | undefined {
    const row = this.db.prepare('SELECT json, fetched_at FROM knowledge_cache WHERE key = ?').get(key) as { json: string; fetched_at: number } | undefined
    return row ? { json: row.json, fetchedAt: row.fetched_at } : undefined
  }
  set(key: string, json: string): void {
    this.db
      .prepare('INSERT INTO knowledge_cache (key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
      .run(key, json, Date.now())
  }
}

// ---- matching ----

export function normalizeTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an)\s+/, '')
}

/** 1 for the same name, otherwise the overlap of their words (0 to 1). */
export function matchScore(query: string, title: string): number {
  const a = normalizeTitle(query)
  const b = normalizeTitle(title)
  if (!a || !b) return 0
  if (a === b) return 1
  const sa = new Set(a.split(' '))
  const sb = new Set(b.split(' '))
  let shared = 0
  for (const t of sa) if (sb.has(t)) shared++
  return shared / (sa.size + sb.size - shared)
}

// ---- Wikidata facts ----

/** Display label per Wikidata property, in the order facts are shown. Facts that an entity lacks are skipped. */
const FACT_PROPS: [string, string][] = [
  ['P569', 'Born'],
  ['P570', 'Died'],
  ['P27', 'Citizenship'],
  ['P106', 'Occupation'],
  ['P26', 'Spouse'],
  ['P69', 'Education'],
  ['P800', 'Notable work'],
  ['P166', 'Awards'],
  ['P17', 'Country'],
  ['P131', 'Located in'],
  ['P36', 'Capital'],
  ['P37', 'Official language'],
  ['P38', 'Currency'],
  ['P1082', 'Population'],
  ['P2046', 'Area'],
  ['P2044', 'Elevation'],
  ['P421', 'Time zone'],
  ['P625', 'Coordinates'],
  ['P571', 'Founded'],
  ['P576', 'Dissolved'],
  ['P112', 'Founder'],
  ['P159', 'Headquarters'],
  ['P169', 'CEO'],
  ['P452', 'Industry'],
  ['P178', 'Developer'],
  ['P50', 'Author'],
  ['P57', 'Director'],
  ['P577', 'Published'],
  ['P136', 'Genre'],
  ['P495', 'Country of origin'],
  ['P856', 'Website']
]
/** Properties that should show one value, not a list. */
const SINGLE = new Set(['P569', 'P570', 'P1082', 'P2046', 'P2044', 'P625', 'P571', 'P576', 'P577', 'P856', 'P36', 'P169'])
/** Take the newest value (last listed) rather than the first. */
const LATEST = new Set(['P1082', 'P169'])
const UNITS: Record<string, string> = { Q712226: 'km²', Q828224: 'km', Q11573: 'm', Q25343: 'm²', Q174728: 'cm', Q11570: 'kg', Q81292: 'acres', Q253276: 'mi' }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

interface Snak {
  snaktype?: string
  datatype?: string
  datavalue?: { type: string; value: unknown }
}
interface Claim {
  mainsnak?: Snak
  rank?: string
}
type Claims = Record<string, Claim[]>

export function formatTime(time: string, precision: number): string | null {
  const m = /^([+-])(\d{1,16})-(\d\d)-(\d\d)/.exec(time)
  if (!m) return null
  const year = Number(m[2])
  const bce = m[1] === '-'
  const y = bce ? `${year} BCE` : String(year)
  if (precision >= 11) {
    const month = MONTHS[Number(m[3]) - 1]
    if (month && Number(m[4]) > 0) return `${Number(m[4])} ${month} ${y}`
  }
  if (precision === 10) {
    const month = MONTHS[Number(m[3]) - 1]
    if (month) return `${month} ${y}`
  }
  if (precision === 8) return `${Math.floor(year / 10) * 10}s${bce ? ' BCE' : ''}`
  if (precision === 7) return `${Math.floor((year - 1) / 100) + 1}${ordinal(Math.floor((year - 1) / 100) + 1)} century${bce ? ' BCE' : ''}`
  return y
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return 'th'
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
}

export function formatCoordinates(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`
}

function chosenClaims(claims: Claims, prop: string): Claim[] {
  const all = (claims[prop] ?? []).filter((c) => c.rank !== 'deprecated' && c.mainsnak?.snaktype === 'value' && c.mainsnak.datavalue)
  const preferred = all.filter((c) => c.rank === 'preferred')
  return preferred.length > 0 ? preferred : all
}

function entityId(c: Claim): string | null {
  const dv = c.mainsnak?.datavalue
  if (dv?.type !== 'wikibase-entityid') return null
  const id = (dv.value as { id?: string }).id
  return typeof id === 'string' ? id : null
}

/** Builds display facts from raw Wikidata claims; `labels` maps item ids to English labels. */
export function buildFacts(claims: Claims, labels: Record<string, string>): { facts: KnowledgeFact[]; website: string | null } {
  const facts: KnowledgeFact[] = []
  let website: string | null = null
  for (const [prop, label] of FACT_PROPS) {
    let list = chosenClaims(claims, prop)
    if (list.length === 0) continue
    if (SINGLE.has(prop)) list = [LATEST.has(prop) ? (list[list.length - 1] as Claim) : (list[0] as Claim)]
    else list = list.slice(0, 3)
    const values: string[] = []
    for (const c of list) {
      const dv = c.mainsnak?.datavalue
      if (!dv) continue
      if (dv.type === 'wikibase-entityid') {
        const id = entityId(c)
        const text = id ? labels[id] : undefined
        if (text) values.push(text)
      } else if (dv.type === 'time') {
        const v = dv.value as { time: string; precision: number }
        const t = formatTime(v.time, v.precision)
        if (t) values.push(t)
      } else if (dv.type === 'quantity') {
        const v = dv.value as { amount: string; unit?: string }
        const n = Number(v.amount)
        if (Number.isFinite(n)) {
          const unitId = /Q\d+$/.exec(v.unit ?? '')?.[0]
          const unit = unitId ? UNITS[unitId] : undefined
          values.push(`${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`)
        }
      } else if (dv.type === 'globecoordinate') {
        const v = dv.value as { latitude: number; longitude: number }
        values.push(formatCoordinates(v.latitude, v.longitude))
      } else if (dv.type === 'monolingualtext') {
        values.push(String((dv.value as { text?: string }).text ?? ''))
      } else if (dv.type === 'string') {
        values.push(String(dv.value))
      }
    }
    const shown = values.filter(Boolean)
    if (shown.length === 0) continue
    if (prop === 'P856') {
      const url = shown[0] as string
      if (/^https?:\/\//i.test(url)) {
        website = url
        facts.push({ label, value: url.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, ''), href: url })
      }
      continue
    }
    let value = shown.join(', ')
    if (prop === 'P569' || prop === 'P570') {
      const place = chosenClaims(claims, prop === 'P569' ? 'P19' : 'P20')[0]
      const id = place ? entityId(place) : null
      if (id && labels[id]) value += ` · ${labels[id]}`
    }
    facts.push({ label, value })
    if (facts.length >= MAX_FACTS) break
  }
  if (facts.length === 0) {
    // Concepts and things without the usual properties still get what kind of thing they are.
    for (const [prop, label] of [['P31', 'Type'], ['P279', 'Subclass of']] as const) {
      const values = chosenClaims(claims, prop).slice(0, 3).map((c) => (entityId(c) ? labels[entityId(c) as string] : undefined)).filter((v): v is string => Boolean(v))
      if (values.length > 0) facts.push({ label, value: values.join(', ') })
    }
  }
  return { facts, website }
}

/** Item ids whose English labels the facts need (values, plus birth and death places). */
export function neededLabelIds(claims: Claims): string[] {
  const ids = new Set<string>()
  for (const [prop] of FACT_PROPS) {
    for (const c of chosenClaims(claims, prop).slice(0, 3)) {
      const id = entityId(c)
      if (id) ids.add(id)
    }
  }
  for (const prop of ['P31', 'P279', 'P19', 'P20']) {
    for (const c of chosenClaims(claims, prop).slice(0, 3)) {
      const id = entityId(c)
      if (id) ids.add(id)
    }
  }
  return [...ids].slice(0, 50)
}

// ---- service ----

interface WikiSummary {
  type?: string
  title?: string
  description?: string
  extract?: string
  wikibase_item?: string
  thumbnail?: { source?: string }
  content_urls?: { desktop?: { page?: string } }
}

export interface KnowledgeDeps {
  cache: KnowledgeCache
  userAgent: string
  isEnabled: () => boolean
  /** Called before a lookup that goes to the network (not for cached answers), so it can be audited. */
  onNetwork?: (entity: string) => void
  fetch?: typeof fetch
}

export class KnowledgeService {
  private readonly inflight = new Map<string, Promise<KnowledgeCard | null>>()
  private readonly doFetch: typeof fetch

  constructor(private readonly deps: KnowledgeDeps) {
    this.doFetch = deps.fetch ?? fetch
  }

  async lookup(query: string): Promise<KnowledgeCard | null> {
    if (!this.deps.isEnabled()) return null
    // Re-validate: only an entity-shaped name may leave the machine.
    const entity = extractEntityQuery(query) ?? (/^[\p{L}\p{N} .,'&:-]{2,80}$/u.test(query.trim()) ? query.trim() : null)
    if (!entity) return null
    const key = normalizeTitle(entity)
    if (!key) return null
    const cached = this.deps.cache.get(key)
    if (cached) {
      const age = Date.now() - cached.fetchedAt
      if (cached.json === 'null' ? age < MISS_TTL_MS : age < CARD_TTL_MS) return cached.json === 'null' ? null : (JSON.parse(cached.json) as KnowledgeCard)
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    const run = this.fetchCard(entity, key).finally(() => this.inflight.delete(key))
    this.inflight.set(key, run)
    return run
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.doFetch(url, { headers: { 'User-Agent': this.deps.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`)
    return (await res.json()) as T
  }

  private async fetchCard(entity: string, key: string): Promise<KnowledgeCard | null> {
    try {
      this.deps.onNetwork?.(entity)
      const search = await this.getJson<{ pages?: { key?: string; title?: string }[] }>(`${WIKIPEDIA}/w/rest.php/v1/search/title?q=${encodeURIComponent(entity)}&limit=5`)
      let summary: WikiSummary | null = null
      for (const page of search.pages ?? []) {
        if (!page.key || !page.title || matchScore(entity, page.title) < MIN_SCORE) continue
        const s = await this.getJson<WikiSummary>(`${WIKIPEDIA}/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`)
        if (s.type === 'disambiguation' || !s.extract || !s.title) continue
        summary = s
        break
      }
      if (!summary) {
        this.deps.cache.set(key, 'null')
        return null
      }
      const qid = summary.wikibase_item && /^Q\d+$/.test(summary.wikibase_item) ? summary.wikibase_item : null
      let facts: KnowledgeFact[] = []
      let website: string | null = null
      let complete = true
      let description = summary.description ?? ''
      if (qid) {
        try {
          const ent = await this.getJson<{ entities?: Record<string, { claims?: Claims; descriptions?: { en?: { value?: string } } }> }>(
            `${WIKIDATA}/w/api.php?action=wbgetentities&ids=${qid}&props=claims|descriptions&languages=en&format=json`
          )
          const e = ent.entities?.[qid]
          const claims = e?.claims ?? {}
          if (!description) description = e?.descriptions?.en?.value ?? ''
          const ids = neededLabelIds(claims)
          let labels: Record<string, string> = {}
          if (ids.length > 0) {
            const lab = await this.getJson<{ entities?: Record<string, { labels?: { en?: { value?: string } } }> }>(
              `${WIKIDATA}/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=labels&languages=en&format=json`
            )
            labels = Object.fromEntries(Object.entries(lab.entities ?? {}).flatMap(([id, v]) => (v.labels?.en?.value ? [[id, v.labels.en.value]] : [])))
          }
          ;({ facts, website } = buildFacts(claims, labels))
        } catch {
          // Wikidata is optional: the Wikipedia summary alone still makes a card, but it is not cached so the facts can arrive next time.
          complete = false
        }
      }
      const thumbnail = summary.thumbnail?.source ? await this.fetchThumbnail(summary.thumbnail.source) : null
      const card: KnowledgeCard = {
        id: qid ?? (summary.title as string),
        title: summary.title as string,
        description,
        extract: trimExtract(summary.extract as string),
        thumbnail,
        facts,
        wikipediaUrl: summary.content_urls?.desktop?.page ?? `${WIKIPEDIA}/wiki/${encodeURIComponent((summary.title as string).replace(/ /g, '_'))}`,
        wikidataUrl: qid ? `${WIKIDATA}/wiki/${qid}` : null,
        website
      }
      if (complete) this.deps.cache.set(key, JSON.stringify(card))
      return card
    } catch {
      // Offline, rate limited or slow: no card, and nothing cached so the next try can succeed.
      return null
    }
  }

  private async fetchThumbnail(url: string): Promise<string | null> {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' || !u.hostname.endsWith('.wikimedia.org')) return null
      const res = await this.doFetch(url, { headers: { 'User-Agent': this.deps.userAgent }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      const type = res.headers.get('content-type') ?? ''
      if (!res.ok || !/^image\/(jpeg|png|webp|gif)/.test(type)) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0 || buf.length > MAX_THUMB_BYTES) return null
      return `data:${type.split(';')[0] ?? 'image/jpeg'};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  }
}

/** Keeps the lead paragraph to about 700 characters, ending on a sentence. */
export function trimExtract(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= 700) return t
  const cut = t.slice(0, 700)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return end > 300 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
}
