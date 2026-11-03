import { randomUUID } from 'node:crypto'
import { USAGE_BATCH_MAX, UsageEventSchema, type UsageEvent } from '@shared/admin-contract'
import type { UsageDetail, UsageSummary } from '@shared/ipc'
import { nowIso, type DB } from '../db'
import { roundUsd } from '../providers/cost'
import { postSplitting } from '../admin/batch'
import { AdminApiError } from '../admin/client'

export interface RecordUsageInput {
  provider: string
  model: string
  kind: UsageEvent['kind']
  path?: UsageEvent['path']
  tokensIn: number
  tokensOut: number
  cachedTokens: number
  costUsd: number
  conversationId: string | null
  messageId: string | null
  /** True when the provider did not report usage (stopped stream) and tokens were estimated. */
  estimated?: boolean
}

export interface SpendSnapshot {
  month_usd: number
  today_usd: number
}

export interface UsageSink {
  post(events: UsageEvent[]): Promise<SpendSnapshot | null>
}

export interface LimitCheck {
  blocked: null | { code: 'limit_daily' | 'limit_monthly' | 'limit_local_daily'; message: string }
  todayUsd: number
  monthUsd: number
}

const BACKOFF_MAX_MS = 60 * 60 * 1000

/** UTC calendar day / month, matching the admin's ISO timestamps. */
export const dayOf = (iso: string): string => iso.slice(0, 10)
export const monthOf = (iso: string): string => iso.slice(0, 7)

/**
 * Local usage ledger + outbox to admin. Every recorded event is written to `usage_events` and
 * `usage_outbox` in one transaction; `flush()` posts batches of up to 200 and backs off on failure.
 */
export class UsageService {
  private flushing: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private soon: NodeJS.Timeout | null = null

  constructor(
    private readonly db: DB,
    private readonly sink: () => UsageSink | null,
    private readonly adminSpend: () => (SpendSnapshot & { month?: string }) | null,
    private readonly onSpend: (s: SpendSnapshot) => void,
    /** Events admin rejected as invalid (or that fail the contract locally) are dropped, never retried. */
    private readonly onDrop: (count: number, reason: string) => void = () => undefined
  ) {}

  record(input: RecordUsageInput): UsageEvent {
    const ev: UsageEvent = {
      id: randomUUID(),
      at: nowIso(),
      provider: input.provider,
      model: input.model,
      path: input.path ?? 'cloud',
      kind: input.kind,
      tokens_in: Math.max(0, Math.round(input.tokensIn)),
      tokens_out: Math.max(0, Math.round(input.tokensOut)),
      cached_tokens: Math.max(0, Math.round(input.cachedTokens)),
      cost_usd: Math.max(0, roundUsd(input.costUsd)),
      conversation_id: input.conversationId
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO usage_events (id, at, provider, model, path, kind, tokens_in, tokens_out, cached_tokens, cost_usd, conversation_id, message_id, estimated)
           VALUES (@id, @at, @provider, @model, @path, @kind, @tokens_in, @tokens_out, @cached_tokens, @cost_usd, @conversation_id, @message_id, @estimated)`
        )
        .run({ ...ev, message_id: input.messageId, estimated: input.estimated ? 1 : 0 })
      this.db.prepare('INSERT INTO usage_outbox (id, attempts, next_attempt_at) VALUES (?, 0, ?)').run(ev.id, ev.at)
    })()
    this.flushSoon()
    return ev
  }

  start(intervalMs = 60_000): void {
    this.stop()
    this.timer = setInterval(() => void this.flush(), intervalMs)
    void this.flush()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.timer = this.soon = null
  }

  flushSoon(delayMs = 5_000): void {
    if (this.soon) return
    this.soon = setTimeout(() => {
      this.soon = null
      void this.flush()
    }, delayMs)
  }

  flush(): Promise<void> {
    if (!this.flushing) this.flushing = this.doFlush().finally(() => (this.flushing = null))
    return this.flushing
  }

  pendingCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM usage_outbox').get() as { n: number }).n
  }

  private async doFlush(): Promise<void> {
    const sink = this.sink()
    if (!sink) return
    for (let round = 0; round < 10; round++) {
      const rows = this.db
        .prepare(
          `SELECT e.id, e.at, e.provider, e.model, e.path, e.kind, e.tokens_in, e.tokens_out, e.cached_tokens, e.cost_usd, e.conversation_id, o.attempts
           FROM usage_outbox o JOIN usage_events e ON e.id = o.id
           WHERE o.next_attempt_at <= ? ORDER BY e.at ASC LIMIT ?`
        )
        .all(nowIso(), USAGE_BATCH_MAX) as (UsageEvent & { attempts: number })[]
      if (rows.length === 0) return
      const valid: UsageEvent[] = []
      const malformed: string[] = []
      for (const { attempts: _a, ...e } of rows) {
        if (UsageEventSchema.safeParse(e).success) valid.push(e)
        else malformed.push(e.id)
      }
      const res = await postSplitting(valid, (batch) => sink.post(batch), (spend) => spend && this.onSpend(spend))
      const done = [...res.sent.map((e) => e.id), ...res.dropped.map((d) => d.item.id), ...malformed]
      const del = this.db.prepare('DELETE FROM usage_outbox WHERE id = ?')
      this.db.transaction(() => done.forEach((id) => del.run(id)))()
      const droppedCount = res.dropped.length + malformed.length
      if (droppedCount) this.onDrop(droppedCount, res.dropped[0]?.reason ?? 'event does not match the admin contract')
      if (res.error !== undefined) {
        const err = res.error
        const msg = err instanceof Error ? err.message : String(err)
        const retryAfter = err instanceof AdminApiError ? err.retryAfterMs : null
        const finished = new Set(done)
        const upd = this.db.prepare('UPDATE usage_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
        this.db.transaction(() => {
          for (const r of rows) {
            if (finished.has(r.id)) continue
            const attempts = r.attempts + 1
            // Admin's Retry-After wins over our own exponential backoff.
            const delay = retryAfter ?? Math.min(30_000 * 2 ** (attempts - 1), BACKOFF_MAX_MS)
            upd.run(attempts, new Date(Date.now() + delay).toISOString(), msg.slice(0, 500), r.id)
          }
        })()
        return
      }
      if (rows.length < USAGE_BATCH_MAX) return
    }
  }

  /** Spend merged from admin (authoritative for what it has received) and local events it has not received yet. */
  merged(now = new Date()): { today: number; month: number } {
    const iso = now.toISOString()
    const day = dayOf(iso)
    const month = monthOf(iso)
    const sum = (sql: string, ...args: unknown[]): number => (this.db.prepare(sql).get(...args) as { s: number | null }).s ?? 0
    const localToday = sum('SELECT SUM(cost_usd) AS s FROM usage_events WHERE substr(at, 1, 10) = ?', day)
    const localMonth = sum('SELECT SUM(cost_usd) AS s FROM usage_events WHERE substr(at, 1, 7) = ?', month)
    const unsentToday = sum(
      'SELECT SUM(e.cost_usd) AS s FROM usage_outbox o JOIN usage_events e ON e.id = o.id WHERE substr(e.at, 1, 10) = ?',
      day
    )
    const unsentMonth = sum(
      'SELECT SUM(e.cost_usd) AS s FROM usage_outbox o JOIN usage_events e ON e.id = o.id WHERE substr(e.at, 1, 7) = ?',
      month
    )
    const admin = this.adminSpend()
    const adminCurrent = admin && (!admin.month || admin.month === month)
    const today = adminCurrent ? Math.max(admin.today_usd + unsentToday, localToday) : localToday
    const monthUsd = adminCurrent ? Math.max(admin.month_usd + unsentMonth, localMonth) : localMonth
    return { today: roundUsd(today), month: roundUsd(monthUsd) }
  }

  summary(now = new Date()): UsageSummary {
    const { today, month } = this.merged(now)
    const monthKey = monthOf(now.toISOString())
    const totals = this.db
      .prepare(
        `SELECT SUM(cost_usd) AS total, SUM(CASE WHEN path = 'local' THEN cost_usd ELSE 0 END) AS local,
                SUM(tokens_in + tokens_out) AS tokens, SUM(CASE WHEN path = 'local' THEN tokens_in + tokens_out ELSE 0 END) AS local_tokens
         FROM usage_events WHERE substr(at, 1, 7) = ?`
      )
      .get(monthKey) as { total: number | null; local: number | null; tokens: number | null; local_tokens: number | null }
    // Local runs cost $0, so the share is measured in tokens.
    const local_share = totals.tokens ? (totals.local_tokens ?? 0) / totals.tokens : 0
    const since = new Date(now.getTime() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const byDay = (
      this.db
        .prepare('SELECT substr(at, 1, 10) AS day, SUM(cost_usd) AS usd FROM usage_events WHERE substr(at, 1, 10) >= ? GROUP BY day ORDER BY day')
        .all(since) as { day: string; usd: number }[]
    ).map((r) => ({ day: r.day, usd: roundUsd(r.usd) }))
    return { month_usd: month, today_usd: today, local_share, byDay }
  }

  forMessage(messageId: string): UsageDetail | null {
    const row = this.db
      .prepare(
        `SELECT provider, model, kind, MIN(at) AS at, SUM(tokens_in) AS tokensIn, SUM(tokens_out) AS tokensOut,
                SUM(cached_tokens) AS cachedTokens, SUM(cost_usd) AS costUsd
         FROM usage_events WHERE message_id = ? AND kind = 'chat' GROUP BY message_id`
      )
      .get(messageId) as (Omit<UsageDetail, 'messageId' | 'pricing'> & { at: string | null }) | undefined
    if (!row || !row.at) return null
    // Pricing comes from the model catalog; the IPC handler fills it in.
    return { ...row, costUsd: roundUsd(row.costUsd), messageId, at: row.at, pricing: null }
  }

  /** Enforce admin daily/monthly limits and the local daily cap before a send. */
  checkLimits(limits: { daily_usd: number | null; monthly_usd: number | null }, localDailyCap: number | null): LimitCheck {
    const { today, month } = this.merged()
    const fmt = (v: number): string => `$${v.toFixed(2)}`
    let blocked: LimitCheck['blocked'] = null
    if (limits.monthly_usd != null && month >= limits.monthly_usd) {
      blocked = { code: 'limit_monthly', message: `Monthly limit reached: ${fmt(month)} of ${fmt(limits.monthly_usd)}. Raise it in Admin > Chat settings.` }
    } else if (limits.daily_usd != null && today >= limits.daily_usd) {
      blocked = { code: 'limit_daily', message: `Daily limit reached: ${fmt(today)} of ${fmt(limits.daily_usd)}. It resets at 00:00 UTC.` }
    } else if (localDailyCap != null && today >= localDailyCap) {
      blocked = { code: 'limit_local_daily', message: `Your local daily cap is reached: ${fmt(today)} of ${fmt(localDailyCap)}. Change it in Settings.` }
    }
    return { blocked, todayUsd: today, monthUsd: month }
  }
}
