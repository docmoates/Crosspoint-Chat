import { DEFAULT_ADMIN_HOST, normalizeAdminHost, normalizePairingCode } from '@shared/admin-contract'
import type { PairResult } from '@shared/ipc'
import type { SecureFile } from '../secure-file'
import { EncryptionUnavailableError } from '../secure-file'
import { AdminApiError, type AdminClient } from './client'

/** What `%APPDATA%\Crosspoint\device.bin` holds (encrypted). */
export interface DeviceRecord {
  host: string
  deviceId: string
  deviceName: string
  token: string
  pairedAt: string
}

export interface DeviceInfo {
  name: string
  os: string
  appVersion: string
}

export interface PairingDeps {
  client: AdminClient
  store: SecureFile<DeviceRecord>
  deviceInfo: () => DeviceInfo
}

/** Owns the device token. Nothing outside main ever sees it. */
export class PairingService {
  private record: DeviceRecord | null

  constructor(private readonly deps: PairingDeps) {
    this.record = deps.store.read()
  }

  get device(): DeviceRecord | null {
    return this.record
  }

  get host(): string {
    return this.record?.host ?? DEFAULT_ADMIN_HOST
  }

  get token(): string | null {
    return this.record?.token ?? null
  }

  isPaired(): boolean {
    return this.record !== null
  }

  async pair(codeInput: string, hostInput?: string): Promise<PairResult> {
    const code = normalizePairingCode(codeInput)
    if (!code) return { ok: false, error: 'Enter the 8-character code shown in Admin > Devices (like ABCD-EFGH).' }
    const host = normalizeAdminHost(hostInput)
    const info = this.deps.deviceInfo()
    try {
      const res = await this.deps.client.pair(host, { code, name: info.name, os: info.os, app_version: info.appVersion })
      const record: DeviceRecord = {
        host,
        deviceId: res.device_id,
        deviceName: info.name,
        token: res.token,
        pairedAt: new Date().toISOString()
      }
      this.deps.store.write(record)
      this.record = record
      return { ok: true }
    } catch (err) {
      return { ok: false, error: pairingErrorMessage(err, host) }
    }
  }

  /** Forget the token. Callers also wipe the config/key cache. */
  unpair(): void {
    this.deps.store.remove()
    this.record = null
  }

  setDeviceName(name: string): void {
    if (!this.record || this.record.deviceName === name) return
    this.record = { ...this.record, deviceName: name }
    try {
      this.deps.store.write(this.record)
    } catch {
      // name is cosmetic; keep the in-memory value
    }
  }
}

export function pairingErrorMessage(err: unknown, host: string): string {
  if (err instanceof EncryptionUnavailableError) return err.message
  if (err instanceof AdminApiError) {
    switch (err.code) {
      case 'bad_code':
        return 'That code is wrong or has expired. Make a new one in Admin > Devices > Pair a new device.'
      case 'rate_limited':
        return 'Too many pairing attempts. Wait a minute and try again.'
      case 'network':
        return `Could not reach ${host}. Check your connection and the admin host.`
      case 'invalid':
        return `Admin rejected the request: ${err.message}`
      default:
        return err.message
    }
  }
  return err instanceof Error ? err.message : String(err)
}
