import { createHash, randomUUID } from 'node:crypto'
import type { AuditKind } from '@shared/admin-contract'
import type { AuditEntry } from '@shared/ipc'
import { nowIso, type DB } from '../db'

export const GENESIS_HASH = '0'.repeat(64)

export function auditHash(prevHash: string, id: string, at: string, kind: string, summary: string): string {
  return createHash('sha256').update(`${prevHash}\n${id}\n${at}\n${kind}\n${summary}`).digest('hex')
}

interface AuditRow {
  id: string
  at: string
  kind: AuditKind
  summary: string
  prev_hash: string
  hash: string
}

/** Append-only audit log with a SHA-256 hash chain. Summaries must never contain secrets. */
export class AuditLog {
  constructor(private readonly db: DB) {}

  append(kind: AuditKind, summary: string): AuditEntry {
    const clean = redact(summary).slice(0, 2000)
    return this.db.transaction(() => {
      const last = this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined
      const prevHash = last?.hash ?? GENESIS_HASH
      const id = randomUUID()
      const at = nowIso()
      const hash = auditHash(prevHash, id, at, kind, clean)
      this.db
        .prepare('INSERT INTO audit (id, at, kind, summary, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, at, kind, clean, prevHash, hash)
      return { id, at, kind, summary: clean, hash, prevHash }
    })()
  }

  list(q?: { limit?: number; before?: string }): AuditEntry[] {
    const limit = q?.limit ?? 200
    const rows = (
      q?.before
        ? this.db
            .prepare('SELECT id, at, kind, summary, prev_hash, hash FROM audit WHERE at < ? ORDER BY seq DESC LIMIT ?')
            .all(q.before, limit)
        : this.db.prepare('SELECT id, at, kind, summary, prev_hash, hash FROM audit ORDER BY seq DESC LIMIT ?').all(limit)
    ) as AuditRow[]
    return rows.map(toEntry)
  }

  /** Recomputes the chain; returns the id of the first broken entry, or null when intact. */
  verify(): string | null {
    const rows = this.db.prepare('SELECT id, at, kind, summary, prev_hash, hash FROM audit ORDER BY seq ASC').all() as AuditRow[]
    let prev = GENESIS_HASH
    for (const r of rows) {
      if (r.prev_hash !== prev || auditHash(prev, r.id, r.at, r.kind, r.summary) !== r.hash) return r.id
      prev = r.hash
    }
    return null
  }

  unreported(limit = 500): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT id, at, kind, summary, prev_hash, hash FROM audit WHERE reported = 0 ORDER BY seq ASC LIMIT ?')
      .all(limit) as AuditRow[]
    return rows.map(toEntry)
  }

  markReported(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE audit SET reported = 1 WHERE id = ?')
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))()
  }
}

function toEntry(r: AuditRow): AuditEntry {
  return { id: r.id, at: r.at, kind: r.kind, summary: r.summary, hash: r.hash, prevHash: r.prev_hash }
}

/** Belt and braces: strip anything that looks like a key or bearer token. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\bdmd_[0-9a-f]{12}_[A-Za-z0-9_-]{32}\b/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
}
