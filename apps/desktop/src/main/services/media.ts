import type { KnowledgeCard } from '@shared/ipc'
import type { DataSyncRemote } from './data-sync'

/** Calls the admin server's video job endpoints. The server picks the model and holds the keys. */
export class MediaClient {
  constructor(private readonly target: () => { baseUrl: string; token: string } | null) {}

  private async call(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const t = this.target()
    if (!t) throw new Error('This device is not paired with admin.')
    const res = await fetch(`${t.baseUrl}${path}`, { ...init, signal, headers: { Authorization: `Bearer ${t.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
    if (res.ok) return res
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `The server answered ${res.status}.`)
  }

  /** Chats, projects and memory on the server. */
  syncRemote(): DataSyncRemote {
    const json = { 'Content-Type': 'application/json' }
    const signal = (): AbortSignal => AbortSignal.timeout(120_000)
    const req = async (path: string, init: RequestInit): Promise<Response> => {
      const t = this.target()
      if (!t) throw new Error('Not signed in.')
      const base = t.baseUrl.replace(/\/v1$/, '')
      const res = await fetch(`${base}${path}`, { ...init, signal: signal(), headers: { Authorization: `Bearer ${t.token}`, ...(init.headers as Record<string, string>) } })
      if (!res.ok) throw new Error(`The server answered ${res.status}.`)
      return res
    }
    return {
      push: async (rows) => void (await req('/sync/push', { method: 'POST', headers: json, body: JSON.stringify({ rows }) })),
      pull: async (since) => (await req(`/sync/pull?since=${since}`, { method: 'GET' })).json() as never,
      putFile: async (id, bytes, mime) => void (await req(`/files/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': mime }, body: new Uint8Array(bytes) })),
      getFile: async (id) => Buffer.from(await (await req(`/files/${encodeURIComponent(id)}`, { method: 'GET' })).arrayBuffer())
    }
  }

  /** A card for the name in this question, from the server. No card on any failure. */
  async knowledge(query: string): Promise<KnowledgeCard | null> {
    try {
      const res = await this.call('/knowledge', { method: 'POST', body: JSON.stringify({ query }) }, AbortSignal.timeout(20_000))
      return ((await res.json()) as { card: KnowledgeCard | null }).card
    } catch {
      return null
    }
  }

  async pollVideo(id: string, signal: AbortSignal): Promise<{ status: string; cost_usd: number | null; error?: string | undefined }> {
    return (await this.call(`/media/video/${encodeURIComponent(id)}`, { method: 'GET' }, signal)).json() as never
  }

  async videoContent(id: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
    const res = await this.call(`/media/video/${encodeURIComponent(id)}/content`, { method: 'GET' }, signal)
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') ?? 'video/mp4').split(';')[0]! }
  }
}
