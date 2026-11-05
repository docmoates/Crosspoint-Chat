import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DB } from '../db'

/** The server holds the data; this database is the copy that stays readable offline. Order matters: parents before children. */
const TABLES = ['projects', 'conversations', 'memories', 'project_files', 'attachments', 'messages', 'artifacts', 'artifact_versions'] as const
type Table = (typeof TABLES)[number]
const FILE_TABLES = new Set<Table>(['attachments', 'project_files'])
const PUSH_BATCH = 50
const MAX_ROW_CHARS = 1_500_000

export interface SyncRow {
  tbl: string
  id: string
  data: Record<string, unknown> | null
}

export interface DataSyncRemote {
  push(rows: SyncRow[]): Promise<void>
  pull(since: number): Promise<{ rows: (SyncRow & { seq: number })[]; more: boolean }>
  putFile(id: string, bytes: Buffer, mime: string): Promise<void>
  getFile(id: string): Promise<Buffer>
}

/** artifact_versions has a two-part key, which travels as one id. */
const VERSION_SEP = '|'

/** Triggers record every local change; run() sends them, then fetches what other devices changed. */
export class DataSync {
  private running: Promise<boolean> | null = null

  constructor(
    private readonly db: DB,
    private readonly remote: () => DataSyncRemote | null,
    private readonly dirs: { attachments: string; projectFiles: string }
  ) {}

  /** True when something arrived from the server. Never overlaps itself. */
  run(): Promise<boolean> {
    if (!this.running) this.running = this.cycle().finally(() => (this.running = null))
    return this.running
  }

  private async cycle(): Promise<boolean> {
    const r = this.remote()
    if (!r) return false
    await this.pushAll(r)
    return this.pullAll(r)
  }

  private async pushAll(r: DataSyncRemote): Promise<void> {
    for (;;) {
      const pending = this.db.prepare('SELECT tbl, id FROM sync_outbox ORDER BY rowid LIMIT ?').all(PUSH_BATCH) as { tbl: Table; id: string }[]
      if (pending.length === 0) return
      const rows: SyncRow[] = []
      for (const p of pending) {
        const row = this.readRow(p.tbl, p.id)
        if (row && FILE_TABLES.has(p.tbl)) await this.uploadOnce(r, p.id, row)
        rows.push({ tbl: p.tbl, id: p.id, data: row ? this.forServer(row) : null })
      }
      await r.push(rows)
      const del = this.db.prepare('DELETE FROM sync_outbox WHERE tbl = ? AND id = ?')
      this.db.transaction(() => {
        for (const p of pending) del.run(p.tbl, p.id)
      })()
    }
  }

  private readRow(tbl: Table, id: string): Record<string, unknown> | null {
    if (tbl === 'artifact_versions') {
      const [artifactId, version] = id.split(VERSION_SEP)
      return (this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(artifactId, Number(version)) as Record<string, unknown>) ?? null
    }
    return (this.db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(id) as Record<string, unknown>) ?? null
  }

  /** The local path means nothing elsewhere, and very long extracted text is cut to fit one stored row. */
  private forServer(row: Record<string, unknown>): Record<string, unknown> {
    const { path: _path, ...rest } = row
    if (typeof rest['text'] === 'string' && rest['text'].length > MAX_ROW_CHARS) rest['text'] = rest['text'].slice(0, MAX_ROW_CHARS)
    return rest
  }

  private async uploadOnce(r: DataSyncRemote, id: string, row: Record<string, unknown>): Promise<void> {
    if (this.db.prepare('SELECT 1 FROM sync_files WHERE id = ?').get(id)) return
    const path = String(row['path'] ?? '')
    if (path && existsSync(path)) await r.putFile(id, readFileSync(path), String(row['mime'] ?? 'application/octet-stream'))
    this.db.prepare('INSERT OR IGNORE INTO sync_files (id) VALUES (?)').run(id)
  }

  private async pullAll(r: DataSyncRemote): Promise<boolean> {
    let changed = false
    for (;;) {
      const since = Number((this.db.prepare('SELECT last_seq FROM sync_state').get() as { last_seq: number }).last_seq)
      const page = await r.pull(since)
      if (page.rows.length === 0) return changed
      this.apply(page.rows)
      changed = true
      if (!page.more) return changed
    }
  }

  /** Writes server rows without recording them as local changes. */
  private apply(rows: (SyncRow & { seq: number })[]): void {
    this.db.transaction(() => {
      this.db.pragma('defer_foreign_keys = ON')
      this.db.prepare('UPDATE sync_state SET applying = 1').run()
      const pendingHere = this.db.prepare('SELECT 1 FROM sync_outbox WHERE tbl = ? AND id = ?')
      for (const row of rows) {
        if (!(TABLES as readonly string[]).includes(row.tbl)) continue
        const tbl = row.tbl as Table
        // A local change that has not been sent yet is newer than this copy.
        if (pendingHere.get(tbl, row.id)) continue
        if (row.data === null) {
          if (tbl === 'artifact_versions') {
            const [a, v] = row.id.split(VERSION_SEP)
            this.db.prepare('DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ?').run(a, Number(v))
          } else {
            this.db.prepare(`DELETE FROM ${tbl} WHERE id = ?`).run(row.id)
          }
          continue
        }
        const data: Record<string, unknown> = { ...row.data }
        if (FILE_TABLES.has(tbl)) {
          data['path'] = join(tbl === 'attachments' ? this.dirs.attachments : this.dirs.projectFiles, row.id, 'file')
          this.db.prepare('INSERT OR IGNORE INTO sync_files (id) VALUES (?)').run(row.id)
        }
        const allowed = (this.db.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string }[]).map((c) => c.name).filter((c) => c in data)
        // An update, never a replace: replacing a chat row would delete its messages through the foreign key.
        const key = tbl === 'artifact_versions' ? ['artifact_id', 'version'] : ['id']
        const sets = allowed.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`)
        this.db
          .prepare(`INSERT INTO ${tbl} (${allowed.join(', ')}) VALUES (${allowed.map(() => '?').join(', ')}) ON CONFLICT(${key.join(', ')}) DO ${sets.length ? `UPDATE SET ${sets.join(', ')}` : 'NOTHING'}`)
          .run(...allowed.map((c) => data[c] as never))
      }
      this.db.prepare('UPDATE sync_state SET applying = 0, last_seq = ?').run(rows[rows.length - 1]!.seq)
    })()
  }

  /** Downloads a file that was added on another device. */
  async ensureFile(id: string, path: string): Promise<void> {
    if (existsSync(path)) return
    const r = this.remote()
    if (!r) throw new Error('This file is not on this PC, and the server cannot be reached.')
    const bytes = await r.getFile(id)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }

  /** Signing out: nothing of this account stays on the PC. */
  wipe(): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE sync_state SET applying = 1').run()
      for (const t of [...TABLES].reverse()) this.db.prepare(`DELETE FROM ${t}`).run()
      this.db.prepare('DELETE FROM usage_events').run()
      this.db.prepare('DELETE FROM sync_outbox').run()
      this.db.prepare('DELETE FROM sync_files').run()
      this.db.prepare('UPDATE sync_state SET applying = 0, last_seq = 0').run()
    })()
    for (const d of [this.dirs.attachments, this.dirs.projectFiles]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // a file in use; it is unreachable from the app now
      }
    }
  }
}
