import { EventEmitter } from 'node:events'
import type { AdminConfig, AdminProvider } from '@shared/admin-contract'
import { EMPTY_APP_CONFIG, type AppConfig, type PairingStatus } from '@shared/ipc'
import type { SecureFile } from '../secure-file'
import { AdminApiError, type AdminClient } from './client'
import type { PairingService } from './pairing'

/** What `%APPDATA%\Crosspoint\config.bin` holds (encrypted): the full admin config, keys included. */
export interface CachedConfig {
  config: AdminConfig
  fetchedAt: string
  host: string
  deviceId: string
}

export interface SyncDeps {
  client: AdminClient
  pairing: PairingService
  cache: SecureFile<CachedConfig>
  intervalMs?: number
  onAudit?: (kind: 'sync' | 'error', summary: string) => void
  /** Called after keys are wiped (unpair or revoke) so other caches (models, provider clients) can drop too. */
  onWipe?: () => void
}

interface SyncEvents {
  status: [PairingStatus]
  config: [AppConfig]
}

/**
 * Keeps the admin config in main memory (keys never leave this process), polls every 60 s with
 * If-None-Match, caches it encrypted for offline use, and wipes everything on 401.
 */
export class ConfigSync extends EventEmitter<SyncEvents> {
  private config: AdminConfig | null = null
  private lastSyncAt: string | undefined
  private error: string | undefined
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<void> | null = null

  constructor(private readonly deps: SyncDeps) {
    super()
    this.loadCache()
  }

  /** Full config with keys. Main process only. */
  get full(): AdminConfig | null {
    return this.config
  }

  provider(id: string): AdminProvider | null {
    return this.config?.providers.find((p) => p.id === id) ?? null
  }

  sanitized(): AppConfig {
    return this.config ? sanitizeConfig(this.config) : EMPTY_APP_CONFIG
  }

  status(): PairingStatus {
    const rec = this.deps.pairing.device
    const status: PairingStatus = { paired: rec !== null, host: this.deps.pairing.host }
    if (rec) status.device = { id: rec.deviceId, name: this.config?.device.name ?? rec.deviceName }
    if (this.lastSyncAt) status.lastSyncAt = this.lastSyncAt
    if (this.error) status.error = this.error
    return status
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.syncNow(), this.deps.intervalMs ?? 60_000)
    void this.syncNow()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Coalesces concurrent calls. Never throws; failures land in status().error. */
  syncNow(): Promise<void> {
    if (!this.inflight) this.inflight = this.doSync().finally(() => (this.inflight = null))
    return this.inflight
  }

  /** Update the spend snapshot from a usage POST response without a full sync. */
  applySpend(spend: { month_usd: number; today_usd: number }): void {
    if (!this.config) return
    this.config = { ...this.config, spend: { ...this.config.spend, ...spend } }
    this.persist()
    this.emit('config', this.sanitized())
  }

  /** Forget token, keys and cached config. */
  wipe(reason?: string): void {
    this.deps.pairing.unpair()
    this.deps.cache.remove()
    this.config = null
    this.lastSyncAt = undefined
    this.error = reason
    this.deps.onWipe?.()
    this.emit('config', this.sanitized())
    this.emit('status', this.status())
  }

  /** After a fresh pairing: drop any old cache and pull immediately. */
  async onPaired(): Promise<void> {
    this.deps.cache.remove()
    this.config = null
    this.error = undefined
    this.emit('status', this.status())
    await this.syncNow()
  }

  private async doSync(): Promise<void> {
    const rec = this.deps.pairing.device
    if (!rec) return
    const before = this.config?.config_version ?? null
    try {
      const res = await this.deps.client.getConfig(rec.host, rec.token, before)
      this.lastSyncAt = new Date().toISOString()
      this.error = undefined
      if (res.status === 'updated') {
        this.config = res.config
        this.deps.pairing.setDeviceName(res.config.device.name)
        this.persist()
        if (before !== res.config.config_version) {
          this.deps.onAudit?.('sync', `config v${res.config.config_version} received (${res.config.providers.length} providers)`)
        }
        this.emit('config', this.sanitized())
      }
    } catch (err) {
      if (err instanceof AdminApiError && err.isAuthFailure) {
        const msg =
          err.code === 'revoked'
            ? 'This device was revoked in admin. Keys were removed; pair again to continue.'
            : 'Admin no longer accepts this device token. Keys were removed; pair again to continue.'
        this.deps.onAudit?.('sync', `device token rejected (${err.code}); local keys wiped`)
        this.wipe(msg)
        return
      }
      const detail = err instanceof Error ? err.message : String(err)
      this.error = this.config ? `${detail} Using the cached config.` : detail
    }
    this.emit('status', this.status())
  }

  private loadCache(): void {
    const cached = this.deps.cache.read()
    const rec = this.deps.pairing.device
    // Only trust a cache written for the device that is paired now.
    if (cached && rec && cached.deviceId === rec.deviceId && cached.host === rec.host) {
      this.config = cached.config
      this.lastSyncAt = cached.fetchedAt
    } else if (cached) {
      this.deps.cache.remove()
    }
  }

  private persist(): void {
    const rec = this.deps.pairing.device
    if (!this.config || !rec) return
    try {
      this.deps.cache.write({ config: this.config, fetchedAt: new Date().toISOString(), host: rec.host, deviceId: rec.deviceId })
    } catch (err) {
      this.deps.onAudit?.('error', `could not cache config: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** The renderer's view: no api keys, no MCP env/headers/command lines. */
export function sanitizeConfig(c: AdminConfig): AppConfig {
  return {
    config_version: c.config_version,
    providers: c.providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      label: p.label,
      base_url: p.base_url,
      enabled: p.enabled,
      hasKey: typeof p.api_key === 'string' && p.api_key.length > 0
    })),
    search: { hasBraveKey: !!c.search.brave_api_key, monthly_quota: c.search.monthly_quota ?? null },
    mcp_servers: c.mcp_servers.map((m) => ({ id: m.id, name: m.name, transport: m.transport, enabled: m.enabled })),
    allowed_models: [...c.allowed_models],
    default_models: { chat: c.default_models.chat ?? null, helper: c.default_models.helper ?? null },
    limits: {
      monthly_usd: c.limits.monthly_usd ?? null,
      daily_usd: c.limits.daily_usd ?? null,
      per_message_warn_usd: c.limits.per_message_warn_usd ?? null,
      sub_chat_usd: c.limits.sub_chat_usd ?? null,
      sub_chat_steps: c.limits.sub_chat_steps ?? null
    },
    spend: { month_usd: c.spend.month_usd, today_usd: c.spend.today_usd, ...(c.spend.month ? { month: c.spend.month } : {}) }
  }
}
