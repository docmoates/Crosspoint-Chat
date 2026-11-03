import { randomUUID } from 'node:crypto'
import type { Artifact, ArtifactListItem, ArtifactWithContent } from '@shared/ipc'
import { nowIso, type DB } from '../db'
import { NotFoundError } from './library'

export interface DetectedArtifact {
  name: string
  kind: Artifact['kind']
  language: string | null
  content: string
}

const TAGGED: Record<string, Artifact['kind']> = {
  html: 'html',
  svg: 'svg',
  mermaid: 'mermaid',
  jsx: 'jsx',
  tsx: 'jsx'
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)\n\1\2[ \t]*$/gm
const MARKER = /<!--\s*artifact:\s*([^>]+?)\s*-->/gi

/**
 * Finds artifacts in assistant text: fenced blocks tagged html/svg/mermaid/jsx(tsx), plus any fenced block
 * (or the text up to the next marker) introduced by `<!-- artifact: name -->`.
 */
export function detectArtifacts(text: string): DetectedArtifact[] {
  const markers: { index: number; end: number; name: string }[] = []
  for (const m of text.matchAll(MARKER)) markers.push({ index: m.index!, end: m.index! + m[0].length, name: m[1]!.trim() })

  const out: DetectedArtifact[] = []
  const usedMarkers = new Set<number>()
  const counters: Record<string, number> = {}
  for (const m of text.matchAll(FENCE)) {
    const lang = (m[3] ?? '').toLowerCase()
    const body = m[4] ?? ''
    const start = m.index!
    // A marker names the block if only whitespace separates them.
    const marker = markers.find((mk, i) => !usedMarkers.has(i) && mk.end <= start && text.slice(mk.end, start).trim() === '')
    const tagged = TAGGED[lang]
    if (!marker && !tagged) continue
    if (marker) usedMarkers.add(markers.indexOf(marker))
    const kind: Artifact['kind'] = tagged ?? (lang === 'md' || lang === 'markdown' ? 'markdown' : 'code')
    const name = marker?.name ?? defaultName(kind, body, (counters[kind] = (counters[kind] ?? 0) + 1))
    out.push({ name, kind, language: lang || null, content: body })
  }
  // Markers without a fenced block: the artifact is the text after the marker up to the next marker.
  markers.forEach((mk, i) => {
    if (usedMarkers.has(i)) return
    const next = markers[i + 1]?.index ?? text.length
    const body = text.slice(mk.end, next).trim()
    if (body) out.push({ name: mk.name, kind: /^\s*</.test(body) ? 'html' : 'markdown', language: null, content: body })
  })
  return out
}

function defaultName(kind: Artifact['kind'], body: string, n: number): string {
  if (kind === 'html') {
    const title = /<title>([^<]{1,80})<\/title>/i.exec(body)?.[1]?.trim()
    if (title) return title
  }
  const label: Record<Artifact['kind'], string> = { html: 'HTML', svg: 'SVG', mermaid: 'Diagram', jsx: 'Component', markdown: 'Document', code: 'Code' }
  return n === 1 ? label[kind] : `${label[kind]} ${n}`
}

interface ArtifactRow {
  id: string
  conversation_id: string
  message_id: string
  name: string
  kind: Artifact['kind']
  language: string | null
  current_version: number
  created_at: string
  updated_at: string
}

const EXT: Record<Artifact['kind'], string> = { html: 'html', svg: 'svg', mermaid: 'mmd', jsx: 'jsx', markdown: 'md', code: 'txt' }

export class ArtifactStore {
  constructor(private readonly db: DB) {}

  /** Store detected artifacts; a repeated name in the same conversation becomes a new version. */
  ingest(conversationId: string, messageId: string, text: string): Artifact[] {
    const found = detectArtifacts(text)
    const out: Artifact[] = []
    for (const a of found) out.push(this.upsert(conversationId, messageId, a, 'model'))
    return out
  }

  list(conversationId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_at').all(conversationId) as ArtifactRow[]).map(toArtifact)
  }

  /** Gallery across chats: newest first, skipping archived conversations. */
  listAll(limit = 200): ArtifactListItem[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, c.title AS conversation_title FROM artifacts a JOIN conversations c ON c.id = a.conversation_id
         WHERE c.archived = 0 ORDER BY a.updated_at DESC LIMIT ?`
      )
      .all(limit) as (ArtifactRow & { conversation_title: string })[]
    return rows.map((r) => ({ ...toArtifact(r), conversationTitle: r.conversation_title }))
  }

  get(id: string): ArtifactWithContent {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined
    if (!row) throw new NotFoundError('Artifact')
    const v = this.db.prepare('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(id, row.current_version) as
      | { content: string }
      | undefined
    return { ...toArtifact(row), content: v?.content ?? '' }
  }

  /** A user edit: saved as a new version. */
  save(id: string, content: string): void {
    const cur = this.get(id)
    if (cur.content === content) return
    const version = cur.version + 1
    const now = nowIso()
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO artifact_versions (artifact_id, version, content, message_id, source, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
        .run(id, version, content, 'user', now)
      this.db.prepare('UPDATE artifacts SET current_version = ?, updated_at = ? WHERE id = ?').run(version, now, id)
    })()
  }

  extension(kind: Artifact['kind'], language: string | null): string {
    if (kind === 'code' && language && /^[a-z0-9+#-]{1,10}$/.test(language)) return language.replace(/[^a-z0-9]/g, '') || 'txt'
    return EXT[kind]
  }

  private upsert(conversationId: string, messageId: string, a: DetectedArtifact, source: 'model' | 'user'): Artifact {
    const now = nowIso()
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM artifacts WHERE conversation_id = ? AND name = ?').get(conversationId, a.name) as ArtifactRow | undefined
      if (existing) {
        const last = this.db
          .prepare('SELECT content FROM artifact_versions WHERE artifact_id = ? AND version = ?')
          .get(existing.id, existing.current_version) as { content: string } | undefined
        if (last?.content === a.content) return toArtifact(existing)
        const version = existing.current_version + 1
        this.db
          .prepare('INSERT INTO artifact_versions (artifact_id, version, content, message_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(existing.id, version, a.content, messageId, source, now)
        this.db
          .prepare('UPDATE artifacts SET current_version = ?, message_id = ?, kind = ?, language = ?, updated_at = ? WHERE id = ?')
          .run(version, messageId, a.kind, a.language, now, existing.id)
        return toArtifact({ ...existing, current_version: version, message_id: messageId, kind: a.kind, language: a.language, updated_at: now })
      }
      const id = randomUUID()
      this.db
        .prepare(
          'INSERT INTO artifacts (id, conversation_id, message_id, name, kind, language, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
        )
        .run(id, conversationId, messageId, a.name, a.kind, a.language, now, now)
      this.db
        .prepare('INSERT INTO artifact_versions (artifact_id, version, content, message_id, source, created_at) VALUES (?, 1, ?, ?, ?, ?)')
        .run(id, a.content, messageId, source, now)
      return { id, conversationId, messageId, name: a.name, kind: a.kind, language: a.language, version: 1, createdAt: now, updatedAt: now }
    })()
  }
}

/**
 * CSP for the `crosspoint-artifact://` preview document. The frame is sandboxed without same-origin, so
 * scripts run in an opaque origin with no preload or IPC. Scripts and styles may also come from the three
 * common CDNs; nothing may be fetched, framed or submitted.
 */
export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  'img-src data: blob: https:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/** The HTML document a preview serves: html as-is, svg centered in a minimal page; other kinds have no preview. */
export function previewDocument(a: Pick<ArtifactWithContent, 'kind' | 'content'>): string | null {
  if (a.kind === 'html') return a.content
  if (a.kind === 'svg')
    return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style>${a.content}`
  return null
}

function toArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    name: r.name,
    kind: r.kind,
    language: r.language,
    version: r.current_version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}
