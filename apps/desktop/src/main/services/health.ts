import { statSync, statfsSync } from 'node:fs'
import type { HealthReport, UpdateState } from '@shared/ipc'
import type { AdminClient } from '../admin/client'
import type { ConfigSync } from '../admin/sync'
import type { PairingService } from '../admin/pairing'
import type { DB } from '../db'
import type { ProviderRegistry } from '../providers/registry'

export interface HealthDeps {
  db: DB
  dbPath: string
  dataDir: string
  client: AdminClient
  pairing: PairingService
  sync: ConfigSync
  registry: ProviderRegistry
  updateState: () => UpdateState
}

const LOW_DISK_BYTES = 1024 * 1024 * 1024
/** Below this the check still passes but carries a fix hint. */
const WARN_DISK_BYTES = 2 * LOW_DISK_BYTES

export const FIX = {
  adminPaired: 'Check the internet connection, then sync. The cached config keeps working meanwhile. If admin revoked this PC, pair again.',
  adminUnpaired: 'Pair this PC: Admin > Devices > Pair a new device, then enter the code here.',
  providerKey: 'The key was rejected. Replace it in admin, then sync.',
  providerOther: 'Check the base URL in admin and that the service is up. Other providers still work.',
  db: 'Restart the app. If it stays red, the database file may be damaged; restore it from a backup of the data folder.',
  disk: 'Free some space on this drive. Chats and attachments need room to save.',
  update: 'Check again from About. Updates also install on their own when you close the app.'
} as const

/** Doctor checks: admin reachable, each enabled provider answers a cheap models call, db, disk, updates. */
export async function checkHealth(d: HealthDeps): Promise<HealthReport> {
  const [admin, providers] = await Promise.all([checkAdmin(d), checkProviders(d)])
  const update = d.updateState()
  return {
    checkedAt: new Date().toISOString(),
    admin,
    providers,
    db: checkDb(d),
    disk: checkDisk(d.dataDir),
    update: { ...update, ...(update.status === 'error' ? { fix: FIX.update } : {}) }
  }
}

async function checkAdmin(d: HealthDeps): Promise<HealthReport['admin']> {
  const host = d.pairing.host
  const paired = d.pairing.isPaired()
  if (paired) {
    const started = Date.now()
    await d.sync.syncNow()
    const status = d.sync.status()
    const latencyMs = Date.now() - started
    if (!status.paired) return { ok: false, host, paired: false, latencyMs, error: status.error ?? 'Device was unpaired', fix: FIX.adminUnpaired }
    return status.error ? { ok: false, host, paired, latencyMs, error: status.error, fix: FIX.adminPaired } : { ok: true, host, paired, latencyMs }
  }
  const probe = await d.client.probe(host)
  return { ...probe, host, paired, fix: FIX.adminUnpaired }
}

async function checkProviders(d: HealthDeps): Promise<HealthReport['providers']> {
  return Promise.all(
    d.registry.all().map(async (p) => {
      const started = Date.now()
      try {
        await p.listModels(AbortSignal.timeout(15_000))
        return { id: p.id, label: p.label, kind: p.kind, ok: true, latencyMs: Date.now() - started }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const fix = /(401|403)|api key|unauthori|authenticat|forbidden/i.test(error) ? FIX.providerKey : FIX.providerOther
        return { id: p.id, label: p.label, kind: p.kind, ok: false, latencyMs: Date.now() - started, error, fix }
      }
    })
  )
}

function checkDb(d: HealthDeps): HealthReport['db'] {
  try {
    const row = d.db.prepare('PRAGMA quick_check').get() as { quick_check: string }
    const sizeBytes = statSync(d.dbPath).size
    return row.quick_check === 'ok'
      ? { ok: true, path: d.dbPath, sizeBytes }
      : { ok: false, path: d.dbPath, sizeBytes, error: row.quick_check, fix: FIX.db }
  } catch (err) {
    return { ok: false, path: d.dbPath, error: err instanceof Error ? err.message : String(err), fix: FIX.db }
  }
}

function checkDisk(path: string): HealthReport['disk'] {
  try {
    const s = statfsSync(path)
    const freeBytes = Number(s.bavail) * Number(s.bsize)
    if (freeBytes < LOW_DISK_BYTES)
      return { ok: false, path, freeBytes, error: `Less than 1 GB free (${(freeBytes / 1024 / 1024).toFixed(0)} MB)`, fix: FIX.disk }
    return freeBytes < WARN_DISK_BYTES ? { ok: true, path, freeBytes, fix: FIX.disk } : { ok: true, path, freeBytes }
  } catch (err) {
    return { ok: false, path, freeBytes: null, error: err instanceof Error ? err.message : String(err), fix: FIX.disk }
  }
}
