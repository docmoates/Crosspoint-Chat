import { AdminApiError } from './client'

export interface BatchOutcome<T> {
  /** Accepted by admin. */
  sent: T[]
  /** Rejected by admin on their own (400 `invalid` / 413): never resend these. */
  dropped: { item: T; reason: string }[]
  /** A transient failure (network, 401, 429, 5xx) that stopped the run; everything not in sent/dropped is unsent. */
  error?: unknown
}

/**
 * Posts `items` as one batch. Admin rejects a whole batch with 400 `invalid` when a single event is bad
 * (contract note 3), so on a rejected payload the batch is halved until the bad events are isolated and
 * dropped; the rest still goes through. Any other failure stops and is returned for the caller to back off.
 */
export async function postSplitting<T, R>(items: T[], post: (batch: T[]) => Promise<R>, onAccepted?: (r: R) => void): Promise<BatchOutcome<T>> {
  const out: BatchOutcome<T> = { sent: [], dropped: [] }
  const run = async (batch: T[]): Promise<boolean> => {
    if (batch.length === 0) return true
    try {
      const r = await post(batch)
      onAccepted?.(r)
      out.sent.push(...batch)
      return true
    } catch (err) {
      if (!(err instanceof AdminApiError && err.isRejectedPayload)) {
        out.error = err
        return false
      }
      if (batch.length === 1) {
        out.dropped.push({ item: batch[0]!, reason: err.message })
        return true
      }
      const mid = Math.ceil(batch.length / 2)
      return (await run(batch.slice(0, mid))) && run(batch.slice(mid))
    }
  }
  await run(items)
  return out
}
