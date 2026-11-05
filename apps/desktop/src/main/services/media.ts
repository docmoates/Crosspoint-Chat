/** Calls the admin server's image and video endpoints. The server picks the model and holds the keys. */
export interface MediaRequest {
  capability: string
  prompt: string
  images?: string[]
}

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

  async image(body: MediaRequest, signal: AbortSignal): Promise<{ media_type: string; b64_json: string; cost_usd: number }> {
    return (await this.call('/media/image', { method: 'POST', body: JSON.stringify(body) }, signal)).json() as never
  }

  async submitVideo(body: MediaRequest, signal: AbortSignal): Promise<{ job_id: string }> {
    return (await this.call('/media/video', { method: 'POST', body: JSON.stringify(body) }, signal)).json() as never
  }

  async pollVideo(id: string, signal: AbortSignal): Promise<{ status: string; cost_usd: number | null; error?: string | undefined }> {
    return (await this.call(`/media/video/${encodeURIComponent(id)}`, { method: 'GET' }, signal)).json() as never
  }

  async videoContent(id: string, signal: AbortSignal): Promise<{ bytes: Buffer; mime: string }> {
    const res = await this.call(`/media/video/${encodeURIComponent(id)}/content`, { method: 'GET' }, signal)
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') ?? 'video/mp4').split(';')[0]! }
  }
}
