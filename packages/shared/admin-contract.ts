/**
 * Admin contract v1: Crosspoint Chat <-> admin.docmoates.com.
 * Mirror of docs/ADMIN-CONTRACT.md. The admin side validates the same shapes with zod in JS;
 * keep both in step. Parsing is deliberately tolerant of extra keys so a newer admin does not
 * break an older app.
 */
import { z } from 'zod'

export const ADMIN_CONTRACT_VERSION = 1
export const DEFAULT_ADMIN_HOST = 'admin.docmoates.com'

/** `dmd_<12 hex id>_<32 base64url chars>` */
export const DeviceTokenSchema = z.string().regex(/^dmd_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/, 'malformed device token')

/** 8 chars from ABCDEFGHJKLMNPQRSTUVWXYZ23456789, grouped XXXX-XXXX. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const PairingCodeSchema = z
  .string()
  .regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/, 'code must look like XXXX-XXXX')

/** Normalizes user input ("abcd efgh", "ABCDEFGH", " abcd-efgh ") to `ABCD-EFGH`. Returns null if it cannot. */
export function normalizePairingCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (raw.length !== 8) return null
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
  return PairingCodeSchema.safeParse(code).success ? code : null
}

// ---------- errors ----------

export const AdminErrorCodeSchema = z.enum(['unauthorized', 'revoked', 'bad_code', 'bad_login', 'rate_limited', 'invalid'])
export type AdminErrorCode = z.infer<typeof AdminErrorCodeSchema>

export const AdminErrorBodySchema = z.looseObject({
  error: z.string(),
  code: z.string().optional()
})
export type AdminErrorBody = z.infer<typeof AdminErrorBodySchema>

// ---------- pairing ----------

export const PairRequestSchema = z.object({
  code: PairingCodeSchema,
  name: z.string().min(1).max(200),
  os: z.string().max(200),
  app_version: z.string().max(50)
})
export type PairRequest = z.infer<typeof PairRequestSchema>

export const PairResponseSchema = z.looseObject({
  device_id: z.string().regex(/^[0-9a-f]{12}$/),
  token: DeviceTokenSchema,
  config_version: z.number().int().nonnegative()
})
export type PairResponse = z.infer<typeof PairResponseSchema>

// ---------- config ----------

export const LimitsSchema = z.looseObject({
  monthly_usd: z.number().nullable().default(null),
  daily_usd: z.number().nullable().default(null),
  per_message_warn_usd: z.number().nullable().default(null)
})
export type Limits = z.infer<typeof LimitsSchema>

export const SpendSchema = z.looseObject({
  month_usd: z.number().default(0),
  today_usd: z.number().default(0),
  month: z.string().optional()
})
export type Spend = z.infer<typeof SpendSchema>

/** Where the app sends messages. Models, prompts and keys stay on the server. */
export const DEFAULT_GATEWAY_PATH = '/api/devices/me/v1'
export const GatewaySchema = z.looseObject({ path: z.string().default(DEFAULT_GATEWAY_PATH) })

export const AdminDeviceSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  created_at: z.string().optional(),
  last_seen_at: z.string().nullable().optional()
})

export const AdminConfigSchema = z.looseObject({
  config_version: z.number().int().nonnegative(),
  device: AdminDeviceSchema,
  gateway: GatewaySchema.default({ path: DEFAULT_GATEWAY_PATH }),
  limits: LimitsSchema.default({ monthly_usd: null, daily_usd: null, per_message_warn_usd: null }),
  spend: SpendSchema.default({ month_usd: 0, today_usd: 0 })
})
export type AdminConfig = z.infer<typeof AdminConfigSchema>

// ---------- usage ----------

export const UsagePathSchema = z.enum(['cloud', 'local', 'cache'])
export const UsageKindSchema = z.enum(['chat', 'helper', 'search', 'image', 'embedding'])

export const UsageEventSchema = z.object({
  id: z.string().uuid(),
  at: z.string(),
  provider: z.string(),
  model: z.string(),
  path: UsagePathSchema,
  kind: UsageKindSchema,
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  conversation_id: z.string().nullable()
})
export type UsageEvent = z.infer<typeof UsageEventSchema>

export const USAGE_BATCH_MAX = 200
export const UsagePostBodySchema = z.object({ events: z.array(UsageEventSchema).max(USAGE_BATCH_MAX) })
export type UsagePostBody = z.infer<typeof UsagePostBodySchema>

export const UsagePostResponseSchema = z.looseObject({
  ok: z.literal(true),
  accepted: z.number().int().nonnegative(),
  spend: z.looseObject({ month_usd: z.number(), today_usd: z.number() }).optional()
})
export type UsagePostResponse = z.infer<typeof UsagePostResponseSchema>

// ---------- audit ----------

export const AuditKindSchema = z.enum(['tool_call', 'permission', 'outbound', 'mcp_approve', 'sync', 'error'])
export type AuditKind = z.infer<typeof AuditKindSchema>

export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  at: z.string(),
  kind: AuditKindSchema,
  summary: z.string().max(2000),
  hash: z.string().regex(/^[0-9a-f]+$/)
})
export type AuditEvent = z.infer<typeof AuditEventSchema>

export const AUDIT_BATCH_MAX = 500
export const AuditPostBodySchema = z.object({ events: z.array(AuditEventSchema).max(AUDIT_BATCH_MAX) })
export type AuditPostBody = z.infer<typeof AuditPostBodySchema>

export const AuditPostResponseSchema = z.looseObject({ ok: z.literal(true) })

// ---------- endpoints ----------

export const AdminPaths = {
  pair: '/api/devices/pair',
  config: '/api/devices/me/config',
  usage: '/api/devices/me/usage',
  audit: '/api/devices/me/audit',
  signIn: '/api/auth/sign-in',
  acceptInvite: '/api/auth/accept-invite'
} as const

/** Accepts "admin.docmoates.com", "https://admin.docmoates.com/", etc.; returns a bare host[:port]. */
export function normalizeAdminHost(input: string | undefined | null): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return DEFAULT_ADMIN_HOST
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    return url.host.toLowerCase()
  } catch {
    return DEFAULT_ADMIN_HOST
  }
}

export function adminUrl(host: string, path: string): string {
  const h = normalizeAdminHost(host)
  // Plain http only for local development of the admin app.
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h) ? 'http' : 'https'
  return `${scheme}://${h}${path}`
}
