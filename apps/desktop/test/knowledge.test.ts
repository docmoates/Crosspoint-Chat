import { describe, expect, it } from 'vitest'
import { extractEntityQuery } from '@shared/entity-query'
import {
  buildFacts,
  formatCoordinates,
  formatTime,
  KnowledgeService,
  matchScore,
  MemoryKnowledgeCache,
  neededLabelIds,
  normalizeTitle,
  trimExtract
} from '../src/main/services/knowledge'

describe('extractEntityQuery', () => {
  it('finds the name in "who/what is" and "tell me about" questions', () => {
    expect(extractEntityQuery('Who is Marie Curie?')).toBe('Marie Curie')
    expect(extractEntityQuery("what's the Eiffel Tower")).toBe('Eiffel Tower')
    expect(extractEntityQuery('What is photosynthesis in simple terms?')).toBe('photosynthesis')
    expect(extractEntityQuery('Tell me about Ada Lovelace')).toBe('Ada Lovelace')
    expect(extractEntityQuery('explain quantum entanglement please')).toBe('quantum entanglement')
  })

  it('accepts a bare proper name', () => {
    expect(extractEntityQuery('Marie Curie')).toBe('Marie Curie')
    expect(extractEntityQuery('Bank of England')).toBe('Bank of England')
  })

  it('ignores chit-chat, personal, long, multi-line and code questions', () => {
    expect(extractEntityQuery('hello')).toBeNull()
    expect(extractEntityQuery('Thanks')).toBeNull()
    expect(extractEntityQuery('what is my balance')).toBeNull()
    expect(extractEntityQuery('Write the OpenRouter adapter for our ChatProvider interface.')).toBeNull()
    expect(extractEntityQuery('who is\nthe boss')).toBeNull()
    expect(extractEntityQuery('what is ```x```')).toBeNull()
    expect(extractEntityQuery('what is ' + 'word '.repeat(30))).toBeNull()
    expect(extractEntityQuery('')).toBeNull()
  })
})

describe('matching', () => {
  it('normalises accents, articles and parentheses', () => {
    expect(normalizeTitle('The Café (restaurant)')).toBe('cafe')
    expect(matchScore('python', 'Python (programming language)')).toBe(1)
    expect(matchScore('Marie Curie', 'Marie Skłodowska Curie')).toBeGreaterThan(0.3)
    expect(matchScore('capital of france', 'Franz Liszt')).toBeLessThan(0.6)
  })
})

describe('Wikidata formatting', () => {
  it('formats dates by precision', () => {
    expect(formatTime('+1867-11-07T00:00:00Z', 11)).toBe('7 November 1867')
    expect(formatTime('+1867-11-00T00:00:00Z', 10)).toBe('November 1867')
    expect(formatTime('+1867-00-00T00:00:00Z', 9)).toBe('1867')
    expect(formatTime('-0384-00-00T00:00:00Z', 9)).toBe('384 BCE')
    expect(formatTime('+1960-00-00T00:00:00Z', 8)).toBe('1960s')
    expect(formatTime('+1850-00-00T00:00:00Z', 7)).toBe('19th century')
  })

  it('formats coordinates', () => {
    expect(formatCoordinates(48.8584, 2.2945)).toBe('48.8584° N, 2.2945° E')
    expect(formatCoordinates(-33.8688, -151.2093)).toBe('33.8688° S, 151.2093° W')
  })

  it('trims long extracts on a sentence', () => {
    const t = `${'Sentence one is here. '.repeat(40)}`
    const out = trimExtract(t)
    expect(out.length).toBeLessThanOrEqual(700)
    expect(out.endsWith('.')).toBe(true)
  })
})

const item = (id: string) => ({ mainsnak: { snaktype: 'value', datavalue: { type: 'wikibase-entityid', value: { id } } } })
const time = (t: string, p: number) => ({ mainsnak: { snaktype: 'value', datavalue: { type: 'time', value: { time: t, precision: p } } } })

const CURIE_CLAIMS = {
  P569: [time('+1867-11-07T00:00:00Z', 11)],
  P19: [item('Q270')],
  P570: [time('+1934-07-04T00:00:00Z', 11)],
  P20: [item('Q214565')],
  P27: [item('Q36'), item('Q142')],
  P106: [item('Q169470'), item('Q593644'), { rank: 'deprecated', ...item('Q1') }],
  P26: [item('Q37463')],
  P856: [{ mainsnak: { snaktype: 'value', datavalue: { type: 'string', value: 'https://example.org/curie/' } } }]
}
const LABELS = { Q270: 'Warsaw', Q214565: 'Passy', Q36: 'Poland', Q142: 'France', Q169470: 'physicist', Q593644: 'chemist', Q37463: 'Pierre Curie' }

describe('buildFacts', () => {
  it('falls back to what kind of thing it is when there are no usual facts', () => {
    const claims = { P31: [item('Q2095')], P279: [item('Q1')] }
    expect(buildFacts(claims as never, { Q2095: 'biological process', Q1: 'process' }).facts).toEqual([
      { label: 'Type', value: 'biological process' },
      { label: 'Subclass of', value: 'process' }
    ])
  })

  it('turns claims into labelled facts, merging birth and death places, skipping deprecated values', () => {
    const { facts, website } = buildFacts(CURIE_CLAIMS as never, LABELS)
    expect(facts).toEqual([
      { label: 'Born', value: '7 November 1867 · Warsaw' },
      { label: 'Died', value: '4 July 1934 · Passy' },
      { label: 'Citizenship', value: 'Poland, France' },
      { label: 'Occupation', value: 'physicist, chemist' },
      { label: 'Spouse', value: 'Pierre Curie' },
      { label: 'Website', value: 'example.org/curie', href: 'https://example.org/curie/' }
    ])
    expect(website).toBe('https://example.org/curie/')
  })

  it('lists the item ids whose labels are needed', () => {
    expect(neededLabelIds(CURIE_CLAIMS as never).sort()).toEqual(['Q142', 'Q169470', 'Q214565', 'Q270', 'Q36', 'Q37463', 'Q593644'].sort())
  })

  it('formats quantities with units and prefers the latest population', () => {
    const q = (amount: string, unit: string) => ({ mainsnak: { snaktype: 'value', datavalue: { type: 'quantity', value: { amount, unit: `http://www.wikidata.org/entity/${unit}` } } } })
    const { facts } = buildFacts({ P1082: [q('+2100000', 'Q199'), q('+2161000', 'Q199')], P2046: [q('+105.4', 'Q712226')] } as never, {})
    expect(facts).toEqual([
      { label: 'Population', value: '2,161,000' },
      { label: 'Area', value: '105.4 km²' }
    ])
  })
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function fakeWiki(calls: string[], opts: { disambiguation?: boolean; noMatch?: boolean; fail?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (opts.fail) throw new Error('offline')
    if (url.includes('/search/title')) {
      if (opts.noMatch) return json({ pages: [{ key: 'Franz_Liszt', title: 'Franz Liszt' }] })
      return json({ pages: [{ key: 'Marie_Curie_(disambiguation)', title: 'Marie Curie (disambiguation)' }, { key: 'Marie_Curie', title: 'Marie Curie' }] })
    }
    if (url.includes('/page/summary/Marie_Curie_(disambiguation)') || url.includes('Marie_Curie_(disambiguation)')) {
      return json({ type: 'disambiguation', title: 'Marie Curie (disambiguation)', extract: 'Marie Curie may refer to...' })
    }
    if (url.includes('/page/summary/Marie_Curie')) {
      return json({
        type: 'standard',
        title: 'Marie Curie',
        description: 'Polish-French physicist and chemist (1867–1934)',
        extract: 'Maria Salomea Skłodowska-Curie was a Polish and naturalised-French physicist and chemist.',
        wikibase_item: 'Q7186',
        thumbnail: { source: 'https://upload.wikimedia.org/thumb/curie.jpg' },
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Marie_Curie' } }
      })
    }
    if (url.includes('props=claims')) return json({ entities: { Q7186: { claims: CURIE_CLAIMS } } })
    if (url.includes('props=labels')) return json({ entities: Object.fromEntries(Object.entries(LABELS).map(([id, v]) => [id, { labels: { en: { value: v } } }])) })
    if (url.includes('upload.wikimedia.org')) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

function service(calls: string[], opts: Parameters<typeof fakeWiki>[1] = {}, enabled = true) {
  const sent: string[] = []
  const svc = new KnowledgeService({ cache: new MemoryKnowledgeCache(), userAgent: 'test', isEnabled: () => enabled, onNetwork: (e) => sent.push(e), fetch: fakeWiki(calls, opts) })
  return { svc, sent }
}

describe('KnowledgeService', () => {
  it('builds a card: skips the disambiguation page, adds facts, thumbnail and links', async () => {
    const calls: string[] = []
    const { svc, sent } = service(calls)
    const card = await svc.lookup('Marie Curie')
    expect(card).toMatchObject({
      id: 'Q7186',
      title: 'Marie Curie',
      description: 'Polish-French physicist and chemist (1867–1934)',
      wikipediaUrl: 'https://en.wikipedia.org/wiki/Marie_Curie',
      wikidataUrl: 'https://www.wikidata.org/wiki/Q7186',
      website: 'https://example.org/curie/'
    })
    expect(card?.thumbnail).toBe('data:image/jpeg;base64,AQIDBA==')
    expect(card?.facts[0]).toEqual({ label: 'Born', value: '7 November 1867 · Warsaw' })
    expect(sent).toEqual(['Marie Curie'])
  })

  it('answers a repeat from the cache without touching the network or the audit hook', async () => {
    const calls: string[] = []
    const { svc, sent } = service(calls)
    await svc.lookup('Marie Curie')
    const n = calls.length
    const again = await svc.lookup('marie curie')
    expect(again?.title).toBe('Marie Curie')
    expect(calls.length).toBe(n)
    expect(sent.length).toBe(1)
  })

  it('returns null when nothing matches well, and remembers the miss', async () => {
    const calls: string[] = []
    const { svc } = service(calls, { noMatch: true })
    expect(await svc.lookup('Marie Curie')).toBeNull()
    const n = calls.length
    expect(await svc.lookup('Marie Curie')).toBeNull()
    expect(calls.length).toBe(n)
  })

  it('returns null offline and does not cache the failure', async () => {
    const calls: string[] = []
    const { svc } = service(calls, { fail: true })
    expect(await svc.lookup('Marie Curie')).toBeNull()
    expect(await svc.lookup('Marie Curie')).toBeNull()
    expect(calls.length).toBe(2)
  })

  it('does not cache a card whose Wikidata part failed, so facts can arrive on the next try', async () => {
    const calls: string[] = []
    const inner = fakeWiki(calls)
    const failing = ((input: string | URL | Request) => (String(input).includes('wikidata.org') ? Promise.reject(new Error('down')) : inner(input))) as typeof fetch
    const svc = new KnowledgeService({ cache: new MemoryKnowledgeCache(), userAgent: 'test', isEnabled: () => true, fetch: failing })
    const first = await svc.lookup('Marie Curie')
    expect(first?.title).toBe('Marie Curie')
    expect(first?.facts).toEqual([])
    const n = calls.length
    await svc.lookup('Marie Curie')
    expect(calls.length).toBeGreaterThan(n)
  })

  it('does nothing when the setting is off', async () => {
    const calls: string[] = []
    const { svc } = service(calls, {}, false)
    expect(await svc.lookup('Marie Curie')).toBeNull()
    expect(calls.length).toBe(0)
  })

  it('refuses text that is not a name', async () => {
    const calls: string[] = []
    const { svc } = service(calls)
    expect(await svc.lookup('write me a function that sorts <items> = [3,1,2]')).toBeNull()
    expect(calls.length).toBe(0)
  })
})
