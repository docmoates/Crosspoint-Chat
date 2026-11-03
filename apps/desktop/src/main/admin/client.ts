import {
  AdminConfigSchema,
  AdminErrorBodySchema,
  AdminPaths,
  AuditPostResponseSchema,
  PairResponseSchema,
  UsagePostResponseSchema,
  adminUrl,
  type AdminConfig,
  type AuditEvent,
  type PairRequest,
  type PairResponse,
  type UsageEvent,
  type UsagePostResponse
} from '@shared/admin-contract'

export type AdminFailureCode = 'unauthorized' | 'revoked' | 'bad_code' | 'rate_limited' | 'invalid' | 'network' | 'bad_response' | 'server'

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly code: AdminFailureCode,
    readonly status: number | null
  ) {
    super(message)
    this.name = 'AdminApiError'
  }

  /** The token is no longer accepted: wipe it. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.code === 'revoked'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface AdminClientOptions {
  fetch?: FetchLike
  timeoutMs?: number
  userAgent?: string
}

export type ConfigResult = { status: 'unchanged' } | { status: 'updated'; config: AdminConfig; etag: string | null }

const KNOWN_CODES = new Set(['unauthorized', 'revoked', 'bad_code', 'rate_limited', 'invalid'])

/** HTTP client for admin.docmoates.com `/api/devices/*`. Never logs or returns the token. */
export class AdminClient {
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly userAgent: string

  constructor(opts: AdminClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.userAgent = opts.userAgent ?? 'CrosspointChat'
  }

  async pair(host: string, body: PairRequest): Promise<PairResponse> {
    const res = await this.request(host, AdminPaths.pair, { method: 'POST', body: JSON.stringify(body) })
    return this.parse(res, PairResponseSchema, host)
  }

  async getConfig(host: string, token: string, configVersion?: number | null): Promise<ConfigResult> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (configVersion != null) headers['If-None-Match'] = `"${configVersion}"`
    const res = await this.request(host, AdminPaths.config, { method: 'GET', headers })
    if (res.status === 304) return { status: 'unchanged' }
    const config = await this.parse(res, AdminConfigSchema, host)
    return { status: 'updated', config, etag: res.headers.get('etag') }
  }

  async postUsage(host: string, token: string, events: UsageEvent[]): Promise<UsagePostResponse> {
    const res = await this.request(host, AdminPaths.usage, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events })
    })
    return this.parse(res, UsagePostResponseSchema, host)
  }

  async postAudit(host: string, token: string, events: AuditEvent[]): Promise<void> {
    const res = await this.request(host, AdminPaths.audit, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events })
    })
    await this.parse(res, AuditPostResponseSchema, host)
  }

  /** Reachability probe without credentials: the admin API answers 401 JSON to an unauthenticated config call. */
  async probe(host: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now()
    try {
      const res = await this.request(host, AdminPaths.config, { method: 'GET' })
      const latencyMs = Date.now() - started
      const json = await res.json().catch(() => null)
      if (res.status === 401 && AdminErrorBodySchema.safeParse(json).success) return { ok: true, latencyMs }
      if (res.ok) return { ok: true, latencyMs }
      return { ok: false, latencyMs, error: toAdminError(res.status, json, host).message }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async request(host: string, path: string, init: RequestInit): Promise<Response> {
    const url = adminUrl(host, path)
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    headers.set('User-Agent', this.userAgent)
    if (init.body) headers.set('Content-Type', 'application/json')
    try {
      // Never follow redirects: the token must only go to the admin API itself, and a redirect means
      // the request hit the HTML console (e.g. sign-in) instead of /api.
      return await this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual' })
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable'
      throw new AdminApiError(`Admin at ${new URL(url).host} ${reason}.`, 'network', null)
    }
  }

  private async parse<T>(res: Response, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, host: string): Promise<T> {
    let json: unknown = null
    const text = await res.text()
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = undefined
    }
    if (!res.ok) throw toAdminError(res.status, json, host)
    if (json === undefined) throw new AdminApiError(`Admin at ${host} returned a response that is not JSON.`, 'bad_response', res.status)
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new AdminApiError(`Admin at ${host} returned an unexpected response shape.`, 'bad_response', res.status)
    return parsed.data
  }
}

export function toAdminError(status: number, json: unknown, host: string): AdminApiError {
  if (status >= 300 && status < 400) {
    return new AdminApiError(`Admin at ${host} redirected the request (HTTP ${status}); its device API may not be deployed yet.`, 'bad_response', status)
  }
  const body = AdminErrorBodySchema.safeParse(json)
  if (!body.success) {
    if (status >= 500) return new AdminApiError(`Admin at ${host} had a server error (HTTP ${status}).`, 'server', status)
    return new AdminApiError(`Admin at ${host} answered HTTP ${status} without a JSON error; is this the admin host?`, 'bad_response', status)
  }
  const raw = body.data.code
  const code: AdminFailureCode = raw && KNOWN_CODES.has(raw)
    ? (raw as AdminFailureCode)
    : status === 401
      ? 'unauthorized'
      : status === 429
        ? 'rate_limited'
        : status >= 500
          ? 'server'
          : 'invalid'
  return new AdminApiError(body.data.error, code, status)
}
