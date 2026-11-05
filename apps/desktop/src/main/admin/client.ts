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

export type AdminFailureCode = 'unauthorized' | 'revoked' | 'bad_code' | 'bad_login' | 'rate_limited' | 'invalid' | 'network' | 'bad_response' | 'server'

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly code: AdminFailureCode,
    readonly status: number | null,
    /** From `Retry-After` (admin sends 60 on 429); null when the server gave none. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
    this.name = 'AdminApiError'
  }

  /**
   * The token is no longer accepted: wipe it. Only a JSON error from the device API counts; a 401 web page
   * (e.g. the HTML console's sign-in gate) must not wipe a valid pairing.
   */
  get isAuthFailure(): boolean {
    return this.code === 'revoked' || this.code === 'unauthorized'
  }

  /**
   * Admin rejected the batch itself (400 `invalid`, or 413 too large). Resending the same events can never
   * succeed, so outboxes split the batch and drop the events that still fail alone.
   */
  get isRejectedPayload(): boolean {
    return (this.status === 400 && this.code === 'invalid') || this.status === 413
  }
}

/** `Retry-After` as delta-seconds or an HTTP date, in ms; null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v) * 1000
  const at = Date.parse(v)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
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

  async signIn(host: string, body: { email: string; password: string; name: string; os: string; app_version: string }): Promise<PairResponse> {
    const res = await this.request(host, AdminPaths.signIn, { method: 'POST', body: JSON.stringify(body) })
    return this.parse(res, PairResponseSchema, host)
  }

  async acceptInvite(host: string, body: { code: string; full_name: string; email: string; password: string; name: string; os: string; app_version: string }): Promise<PairResponse> {
    const res = await this.request(host, AdminPaths.acceptInvite, { method: 'POST', body: JSON.stringify(body) })
    return this.parse(res, PairResponseSchema, host)
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
      return { ok: false, latencyMs, error: toAdminError(res.status, json, host, res.headers).message }
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
    if (!res.ok) throw toAdminError(res.status, json, host, res.headers)
    if (json === undefined) throw new AdminApiError(`Admin at ${host} returned a response that is not JSON.`, 'bad_response', res.status)
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new AdminApiError(`Admin at ${host} returned an unexpected response shape.`, 'bad_response', res.status)
    return parsed.data
  }
}

export function toAdminError(status: number, json: unknown, host: string, headers?: Headers): AdminApiError {
  const retryAfterMs = parseRetryAfter(headers?.get('retry-after') ?? null) ?? (status === 429 ? 60_000 : null)
  if (status >= 300 && status < 400) {
    return new AdminApiError(`Admin at ${host} redirected the request (HTTP ${status}); its device API may not be deployed yet.`, 'bad_response', status)
  }
  const body = AdminErrorBodySchema.safeParse(json)
  if (!body.success) {
    if (status >= 500) return new AdminApiError(`Admin at ${host} had a server error (HTTP ${status}).`, 'server', status, retryAfterMs)
    if (status === 429) return new AdminApiError(`Admin at ${host} is rate limiting this device (HTTP 429).`, 'rate_limited', status, retryAfterMs)
    return new AdminApiError(
      `Admin at ${host} answered HTTP ${status} without a JSON error (a web page, not the device API); its device API may not be deployed yet.`,
      'bad_response',
      status
    )
  }
  // Admin labels 404/405/413/500 `invalid` too (contract note 9); classify by status first so a server
  // error is retried and never mistaken for a rejected payload.
  if (status >= 500) return new AdminApiError(`Admin at ${host} had a server error (HTTP ${status}): ${body.data.error}`, 'server', status, retryAfterMs)
  if (status === 404 || status === 405) {
    return new AdminApiError(`Admin at ${host} has no such device API route (HTTP ${status}); it may not be deployed yet.`, 'invalid', status)
  }
  const raw = body.data.code
  if (raw && KNOWN_CODES.has(raw)) return new AdminApiError(body.data.error, raw as AdminFailureCode, status, retryAfterMs)
  if (status === 429) return new AdminApiError(body.data.error, 'rate_limited', status, retryAfterMs)
  // Every device API error carries a contract code. A JSON error without one comes from the HTML console's
  // own gates (e.g. its CSRF check answers 403), so the device API is not there: never wipe or drop on it.
  return new AdminApiError(
    `Admin at ${host} answered HTTP ${status} from its web console ("${body.data.error.slice(0, 160)}"), not from the device API; the device API may not be deployed yet.`,
    'bad_response',
    status
  )
}
