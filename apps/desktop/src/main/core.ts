import { app, safeStorage } from 'electron'
import { hostname, release } from 'node:os'
import type { AppConfig, KnowledgeCard, PairingStatus, StreamEvent, UpdateState } from '@shared/ipc'
import { adminUrl, AuditEventSchema, AUDIT_BATCH_MAX, DEFAULT_GATEWAY_PATH } from '@shared/admin-contract'
import { postSplitting } from './admin/batch'
import { AdminApiError, AdminClient } from './admin/client'
import { PairingService, type DeviceRecord } from './admin/pairing'
import { ConfigSync, type CachedConfig } from './admin/sync'
import { openDatabase, type DB } from './db'
import { appPaths } from './paths'
import { OpenAICompatProvider } from './providers/openai-compat'
import type { ChatProvider } from './providers/types'
import { SecureFile } from './secure-file'
import { ArtifactStore } from './services/artifacts'
import { AuditLog } from './services/audit'
import { ChatService } from './services/chat'
import { DataSync } from './services/data-sync'
import { MediaClient } from './services/media'
import { FileStore } from './services/files'
import { Library } from './services/library'
import { SettingsService } from './services/settings'
import { UsageService } from './services/usage'
import { Updater } from './updates'

export interface CoreEvents {
  pairingStatus: (s: PairingStatus) => void
  configChange: (c: AppConfig) => void
  chat: (e: StreamEvent) => void
  updates: (s: UpdateState) => void
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
  usage: UsageService
  knowledge: { lookup(query: string): Promise<KnowledgeCard | null> }
  files: FileStore
  artifacts: ArtifactStore
  chat: ChatService
  data: DataSync
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

  // The only upstream: this device's token against the admin server, which picks the model and holds the keys.
  let data: DataSync | null = null
  let gatewayCache: { fingerprint: string; provider: ChatProvider } | null = null
  const sync = new ConfigSync({
    client,
    pairing,
    cache: new SecureFile<CachedConfig>(paths.configFile, safeStorage),
    onAudit: (kind, summary) => audit.append(kind, summary),
    onWipe: () => {
      gatewayCache = null
      data?.wipe()
    }
  })
  const gateway = (): ChatProvider | null => {
    const rec = pairing.device
    if (!rec) return null
    const baseUrl = adminUrl(rec.host, sync.full?.gateway.path ?? DEFAULT_GATEWAY_PATH)
    const fingerprint = `${baseUrl}|${rec.token}`
    if (gatewayCache?.fingerprint !== fingerprint) {
      gatewayCache = { fingerprint, provider: new OpenAICompatProvider({ id: 'crosspoint', label: 'Crosspoint', baseUrl, apiKey: rec.token }) }
    }
    return gatewayCache.provider
  }

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
    (spend) => sync.applySpend(spend),
    (count, reason) => audit.append('error', `admin rejected ${count} usage event(s) as invalid; dropped from the outbox: ${reason}`)
  )

  const media = new MediaClient(() => {
    const rec = pairing.device
    return rec ? { baseUrl: adminUrl(rec.host, sync.full?.gateway.path ?? DEFAULT_GATEWAY_PATH), token: rec.token } : null
  })
  data = new DataSync(db, () => (pairing.device ? media.syncRemote() : null), { attachments: paths.attachments, projectFiles: paths.projectFiles })
  const dataSync = data
  const syncData = (): void => {
    dataSync
      .run()
      .then((changed) => {
        if (changed) {
          sync.dataVersion++
          events.pairingStatus(sync.status())
        }
      })
      .catch(() => undefined) // kept in the outbox; the next round retries
  }
  const knowledge = { lookup: async (query: string) => (settings.get().knowledgeCards ? media.knowledge(query) : null) }

  const files = new FileStore(db, paths.attachments, paths.projectFiles)
  const artifacts = new ArtifactStore(db)
  const chat = new ChatService({
    library,
    files,
    artifacts,
    usage,
    gateway,
    media,
    data: dataSync,
    settings,
    audit,
    config: () => sync.full,
    emit: events.chat
  })
  const updater = new Updater(events.updates)

  sync.on('status', (s) => {
    events.pairingStatus(s)
    if (s.paired && !s.offline) syncData()
  })
  sync.on('config', (c) => {
    events.configChange(c)
  })

  let auditTimer: NodeJS.Timeout | null = null
  let auditRetryAt = 0
  async function postAuditSummary(force = false): Promise<void> {
    const rec = pairing.device
    if (!rec) return
    const last = Number(settings.getInternal('audit.lastPostAt') ?? 0)
    if (!force && Date.now() - last < DAY) return
    if (Date.now() < auditRetryAt) return
    for (let round = 0; round < 10; round++) {
      const pending = audit.unreported(AUDIT_BATCH_MAX).map(({ id, at, kind, summary, hash }) => ({ id, at, kind, summary, hash }))
      const valid = pending.filter((e) => AuditEventSchema.safeParse(e).success)
      const res = await postSplitting(valid, (batch) => client.postAudit(rec.host, rec.token, batch))
      // Rejected or malformed entries stay in the local chain but are never resent.
      const sentOrDropped = new Set([...res.sent, ...res.dropped.map((d) => d.item)].map((e) => e.id))
      audit.markReported(pending.filter((e) => sentOrDropped.has(e.id) || !valid.includes(e)).map((e) => e.id))
      if (res.error !== undefined) {
        const err = res.error
        if (err instanceof AdminApiError && err.retryAfterMs != null) auditRetryAt = Date.now() + err.retryAfterMs
        if (err instanceof AdminApiError && err.isAuthFailure) void sync.syncNow()
        return
      }
      if (pending.length < AUDIT_BATCH_MAX) break
    }
    settings.setInternal('audit.lastPostAt', String(Date.now()))
  }

  function start(): void {
    sync.start()
    usage.start()
    auditTimer = setInterval(() => void postAuditSummary(), 60 * 60 * 1000)
    setTimeout(() => void postAuditSummary(), 30_000)
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

  return { paths, db, client, audit, settings, library, pairing, sync, usage, knowledge, files, artifacts, chat, data: dataSync, updater, start, stop }
}

