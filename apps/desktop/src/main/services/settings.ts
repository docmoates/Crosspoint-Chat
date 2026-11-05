import { LocalSettingsPatchSchema, type LocalSettings } from '@shared/ipc'
import type { DB } from '../db'

const DEFAULTS: Omit<LocalSettings, 'dataFolder'> = {
  theme: 'system',
  font: 'system',
  fontSize: 14,
  sendOnEnter: true,
  knowledgeCards: true,
  replyDetails: 'full',
  defaultModelOverride: null,
  dailyCapUsd: null
}

/** Local-only preferences in the `settings` table (one JSON value per key). */
export class SettingsService {
  constructor(
    private readonly db: DB,
    private readonly dataFolder: string
  ) {}

  get(): LocalSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all('pref.%') as { key: string; value: string }[]
    const stored: Record<string, unknown> = {}
    for (const r of rows) {
      try {
        stored[r.key.slice(5)] = JSON.parse(r.value)
      } catch {
        // ignore a corrupt value; the default applies
      }
    }
    const valid: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(stored)) {
      const one = LocalSettingsPatchSchema.safeParse({ [k]: v })
      if (one.success) Object.assign(valid, one.data)
    }
    return { ...DEFAULTS, ...valid, dataFolder: this.dataFolder }
  }

  set(patch: Partial<LocalSettings>): void {
    const clean = LocalSettingsPatchSchema.parse(patch)
    const upsert = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(clean)) {
        if (k === 'dataFolder' || v === undefined) continue
        upsert.run(`pref.${k}`, JSON.stringify(v))
      }
    })()
  }

  /** Internal key/value state (not user preferences). */
  getInternal(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`internal.${key}`) as { value: string } | undefined
    return row?.value ?? null
  }

  setInternal(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`internal.${key}`, value)
  }
}
