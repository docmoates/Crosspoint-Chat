import { EventEmitter } from 'node:events'
import type { AdminConfig } from '@shared/admin-contract'
import { EMPTY_APP_CONFIG, type AppConfig, type PairingStatus } from '@shared/ipc'
import type { SecureFile } from '../secure-file'
import { AdminApiError, type AdminClient } from './client'
import type { PairingService } from './pairing'

/** What `%APPDATA%\Crosspoint\config.bin` holds (encrypted): the admin config. */
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
 * Keeps the admin config in main memory, polls every 60 s with
 * If-None-Match, caches it encrypted for offline use, and wipes everything on 401.
 */
export class ConfigSync extends EventEmitter<SyncEvents> {
  private config: AdminConfig | null = null
  private lastSyncAt: string | undefined
  private error: string | undefined
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<void> | null = null
  /** Epoch ms before which admin asked us (Retry-After) not to call again. */
  private retryAt = 0

  constructor(private readonly deps: SyncDeps) {
    super()
    this.loadCache()
  }

  /** Full config. Main process only. */
  get full(): AdminConfig | null {
    return this.config
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
    this.retryAt = 0
    this.deps.cache.remove()
    this.config = null
    this.error = undefined
    this.emit('status', this.status())
    await this.syncNow()
  }

  private async doSync(): Promise<void> {
    const rec = this.deps.pairing.device
    if (!rec) return
    if (Date.now() < this.retryAt) return
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
          this.deps.onAudit?.('sync', `config v${res.config.config_version} received`)
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
      if (err instanceof AdminApiError && err.retryAfterMs != null) this.retryAt = Date.now() + err.retryAfterMs
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

/** The renderer's view. Unknown admin keys (e.g. mcp_servers) are dropped here. */
export function sanitizeConfig(c: AdminConfig): AppConfig {
  return {
    config_version: c.config_version,
    limits: {
      monthly_usd: c.limits.monthly_usd ?? null,
      daily_usd: c.limits.daily_usd ?? null,
      per_message_warn_usd: c.limits.per_message_warn_usd ?? null
    },
    spend: { month_usd: c.spend.month_usd, today_usd: c.spend.today_usd, ...(c.spend.month ? { month: c.spend.month } : {}) }
  }
}
