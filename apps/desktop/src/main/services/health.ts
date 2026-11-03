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

/** Doctor checks: admin reachable, each enabled provider answers a cheap models call, db, disk, updates. */
export async function checkHealth(d: HealthDeps): Promise<HealthReport> {
  const [admin, providers] = await Promise.all([checkAdmin(d), checkProviders(d)])
  return { checkedAt: new Date().toISOString(), admin, providers, db: checkDb(d), disk: checkDisk(d.dataDir), update: d.updateState() }
}

async function checkAdmin(d: HealthDeps): Promise<HealthReport['admin']> {
  const host = d.pairing.host
  const paired = d.pairing.isPaired()
  if (paired) {
    const started = Date.now()
    await d.sync.syncNow()
    const status = d.sync.status()
    const latencyMs = Date.now() - started
    if (!status.paired) return { ok: false, host, paired: false, latencyMs, error: status.error ?? 'Device was unpaired' }
    return status.error ? { ok: false, host, paired, latencyMs, error: status.error } : { ok: true, host, paired, latencyMs }
  }
  const probe = await d.client.probe(host)
  return { ...probe, host, paired }
}

async function checkProviders(d: HealthDeps): Promise<HealthReport['providers']> {
  return Promise.all(
    d.registry.all().map(async (p) => {
      const started = Date.now()
      try {
        await p.listModels(AbortSignal.timeout(15_000))
        return { id: p.id, label: p.label, kind: p.kind, ok: true, latencyMs: Date.now() - started }
      } catch (err) {
        return { id: p.id, label: p.label, kind: p.kind, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )
}

function checkDb(d: HealthDeps): HealthReport['db'] {
  try {
    const row = d.db.prepare('PRAGMA quick_check').get() as { quick_check: string }
    const sizeBytes = statSync(d.dbPath).size
    return row.quick_check === 'ok' ? { ok: true, path: d.dbPath, sizeBytes } : { ok: false, path: d.dbPath, sizeBytes, error: row.quick_check }
  } catch (err) {
    return { ok: false, path: d.dbPath, error: err instanceof Error ? err.message : String(err) }
  }
}

function checkDisk(path: string): HealthReport['disk'] {
  try {
    const s = statfsSync(path)
    const freeBytes = Number(s.bavail) * Number(s.bsize)
    return freeBytes < LOW_DISK_BYTES
      ? { ok: false, path, freeBytes, error: `Less than 1 GB free (${(freeBytes / 1024 / 1024).toFixed(0)} MB)` }
      : { ok: true, path, freeBytes }
  } catch (err) {
    return { ok: false, path, freeBytes: null, error: err instanceof Error ? err.message : String(err) }
  }
}
