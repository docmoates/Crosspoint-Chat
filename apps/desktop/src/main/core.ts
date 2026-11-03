import { app, safeStorage } from 'electron'
import { hostname, release } from 'node:os'
import type { AppConfig, PairingStatus, StreamEvent } from '@shared/ipc'
import { AdminApiError, AdminClient } from './admin/client'
import { PairingService, type DeviceRecord } from './admin/pairing'
import { ConfigSync, type CachedConfig } from './admin/sync'
import { openDatabase, type DB } from './db'
import { appPaths } from './paths'
import { ProviderRegistry } from './providers/registry'
import { SecureFile } from './secure-file'
import { ArtifactStore } from './services/artifacts'
import { AuditLog } from './services/audit'
import { ChatService } from './services/chat'
import { FileStore } from './services/files'
import { Library } from './services/library'
import { ModelCatalog } from './services/models'
import { SettingsService } from './services/settings'
import { UsageService } from './services/usage'
import { Updater } from './updates'

export interface CoreEvents {
  pairingStatus: (s: PairingStatus) => void
  configChange: (c: AppConfig) => void
  chat: (e: StreamEvent) => void
}

const DAY = 24 * 60 * 60 * 1000

export function windowsVersionLabel(): string {
  const r = release() // e.g. 10.0.28000
  const build = Number(r.split('.')[2] ?? 0)
  return `Windows ${build >= 22000 ? '11' : '10'} ${r}`
}

export interface Core {
  paths: ReturnType<typeof appPaths>
  db: DB
  client: AdminClient
  audit: AuditLog
  settings: SettingsService
  library: Library
  pairing: PairingService
  sync: ConfigSync
  registry: ProviderRegistry
  catalog: ModelCatalog
  usage: UsageService
  files: FileStore
  artifacts: ArtifactStore
  chat: ChatService
  updater: Updater
  start(): void
  stop(): void
}

/** Wires every main-process service together. Created once after `app.whenReady()`. */
export function createCore(events: CoreEvents): Core {
  const paths = appPaths()
  const db: DB = openDatabase(paths.database)
  const client = new AdminClient({ userAgent: `CrosspointChat/${app.getVersion()} (${windowsVersionLabel()})` })
  const audit = new AuditLog(db)
  const settings = new SettingsService(db, paths.root)
  const library = new Library(db)
  library.recoverInterrupted()

  const pairing = new PairingService({
    client,
    store: new SecureFile<DeviceRecord>(paths.deviceFile, safeStorage),
    deviceInfo: () => ({ name: hostname(), os: process.platform === 'win32' ? windowsVersionLabel() : `${process.platform} ${release()}`, appVersion: app.getVersion() })
  })

  let registry: ProviderRegistry | null = null
  let catalog: ModelCatalog | null = null
  const sync = new ConfigSync({
    client,
    pairing,
    cache: new SecureFile<CachedConfig>(paths.configFile, safeStorage),
    onAudit: (kind, summary) => audit.append(kind, summary),
    onWipe: () => {
      registry?.clear()
      catalog?.clearCache()
    }
  })
  registry = new ProviderRegistry(() => sync.full?.providers ?? [], app.getVersion())
  catalog = new ModelCatalog(db, registry, () => sync.full)

  const usage = new UsageService(
    db,
    () => {
      const rec = pairing.device
      if (!rec) return null
      return {
        post: async (events) => {
          const res = await client.postUsage(rec.host, rec.token, events)
          return res.spend ?? null
        }
      }
    },
    () => sync.full?.spend ?? null,
    (spend) => sync.applySpend(spend)
  )

  const files = new FileStore(db, paths.attachments, paths.projectFiles)
  const artifacts = new ArtifactStore(db)
  const chat = new ChatService({
    library,
    files,
    artifacts,
    usage,
    catalog,
    registry,
    settings,
    audit,
    config: () => sync.full,
    emit: events.chat
  })
  const updater = new Updater()

  sync.on('status', events.pairingStatus)
  sync.on('config', (c) => {
    registry?.clear()
    events.configChange(c)
    void catalog?.refresh().catch(() => undefined)
  })

  let auditTimer: NodeJS.Timeout | null = null
  async function postAuditSummary(force = false): Promise<void> {
    const rec = pairing.device
    if (!rec) return
    const last = Number(settings.getInternal('audit.lastPostAt') ?? 0)
    if (!force && Date.now() - last < DAY) return
    const pending = audit.unreported(500)
    try {
      if (pending.length) {
        await client.postAudit(
          rec.host,
          rec.token,
          pending.map(({ id, at, kind, summary, hash }) => ({ id, at, kind, summary, hash }))
        )
        audit.markReported(pending.map((e) => e.id))
      }
      settings.setInternal('audit.lastPostAt', String(Date.now()))
    } catch (err) {
      if (err instanceof AdminApiError && err.isAuthFailure) void sync.syncNow()
    }
  }

  function start(): void {
    sync.start()
    usage.start()
    auditTimer = setInterval(() => void postAuditSummary(), 60 * 60 * 1000)
    setTimeout(() => void postAuditSummary(), 30_000)
    void catalog!.refresh().catch(() => undefined)
    setTimeout(() => void updater.check(), 15_000)
  }

  function stop(): void {
    chat.stopAll()
    sync.stop()
    usage.stop()
    if (auditTimer) clearInterval(auditTimer)
    try {
      db.close()
    } catch {
      // already closed
    }
  }

  return { paths, db, client, audit, settings, library, pairing, sync, registry, catalog, usage, files, artifacts, chat, updater, start, stop }
}

