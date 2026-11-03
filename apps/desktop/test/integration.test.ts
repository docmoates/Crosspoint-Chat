import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postSplitting } from '../src/main/admin/batch'
import { AdminApiError, AdminClient, parseRetryAfter, toAdminError, type FetchLike } from '../src/main/admin/client'
import { PairingService, type DeviceRecord } from '../src/main/admin/pairing'
import { ConfigSync, type CachedConfig } from '../src/main/admin/sync'
import { openDatabase, type DB } from '../src/main/db'
import { usable } from '../src/main/providers/registry'
import { SecureFile, type StringCipher } from '../src/main/secure-file'
import { ArtifactStore, previewDocument } from '../src/main/services/artifacts'
import { Library } from '../src/main/services/library'
import { SettingsService } from '../src/main/services/settings'
import { UsageService, type UsageSink } from '../src/main/services/usage'
import type { UsageEvent } from '@shared/admin-contract'

const cipher: StringCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}
const TOKEN = 'dmd_a1b2c3d4e5f6_abcdefghijklmnopqrstuvwxyzABCDEF'
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

let dir: string
let db: DB
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crosspoint-int-'))
  db = openDatabase(join(dir, 'crosspoint.sqlite'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('admin error classification (contract notes 3, 9)', () => {
  it('treats 400 invalid as a rejected payload but 500 invalid as a retryable server error', () => {
    const bad = toAdminError(400, { error: 'unknown kind', code: 'invalid' }, 'h')
    expect(bad.isRejectedPayload).toBe(true)
    const server = toAdminError(500, { error: 'boom', code: 'invalid' }, 'h')
    expect(server.code).toBe('server')
    expect(server.isRejectedPayload).toBe(false)
    expect(toAdminError(404, { error: 'nope', code: 'invalid' }, 'h').message).toMatch(/not be deployed/)
  })

  it('reads Retry-After and defaults 429 to 60 s', () => {
    expect(toAdminError(429, { error: 'slow', code: 'rate_limited' }, 'h', new Headers({ 'retry-after': '60' })).retryAfterMs).toBe(60_000)
    expect(toAdminError(429, { error: 'slow' }, 'h').retryAfterMs).toBe(60_000)
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT'))).toBe(60_000)
  })

  it('does not treat a 401 web page as a revoked token', () => {
    const html = toAdminError(401, undefined, 'h')
    expect(html.isAuthFailure).toBe(false)
    expect(html.message).toMatch(/web page/)
    expect(toAdminError(401, { error: 'gone', code: 'revoked' }, 'h').isAuthFailure).toBe(true)
  })
})

describe('postSplitting', () => {
  it('isolates and drops the events admin rejects, sends the rest', async () => {
    const post = vi.fn(async (batch: number[]) => {
      if (batch.includes(3)) throw new AdminApiError('bad kind', 'invalid', 400)
      return batch.length
    })
    const res = await postSplitting([1, 2, 3, 4, 5], post)
    expect(res.sent.sort()).toEqual([1, 2, 4, 5])
    expect(res.dropped.map((d) => d.item)).toEqual([3])
    expect(res.error).toBeUndefined()
  })

  it('stops on a transient error and reports it', async () => {
    const res = await postSplitting([1, 2], async () => {
      throw new AdminApiError('down', 'server', 503, 5000)
    })
    expect(res.sent).toEqual([])
    expect(res.dropped).toEqual([])
    expect((res.error as AdminApiError).retryAfterMs).toBe(5000)
  })
})

describe('usage outbox', () => {
  const record = (u: UsageService, kind: UsageEvent['kind'] = 'chat'): UsageEvent =>
    u.record({ provider: 'openrouter', model: 'm', kind, tokensIn: 10, tokensOut: 5, cachedTokens: 0, costUsd: 0.01, conversationId: null, messageId: null })

  it('drops events admin rejects as invalid instead of retrying them', async () => {
    let badId = ''
    const sink: UsageSink = {
      post: async (events) => {
        if (events.some((e) => e.id === badId)) throw new AdminApiError('unknown kind', 'invalid', 400)
        return { month_usd: 1, today_usd: 1 }
      }
    }
    const dropped = vi.fn()
    const u = new UsageService(db, () => sink, () => null, () => undefined, dropped)
    u.stop()
    record(u)
    badId = record(u).id
    record(u)
    u.stop()
    await u.flush()
    expect(u.pendingCount()).toBe(0)
    expect(dropped).toHaveBeenCalledWith(1, 'unknown kind')
  })

  it('honours Retry-After on 429', async () => {
    const sink: UsageSink = {
      post: async () => {
        throw new AdminApiError('slow down', 'rate_limited', 429, 120_000)
      }
    }
    const u = new UsageService(db, () => sink, () => null, () => undefined)
    record(u)
    u.stop()
    const before = Date.now()
    await u.flush()
    const row = db.prepare('SELECT attempts, next_attempt_at FROM usage_outbox').get() as { attempts: number; next_attempt_at: string }
    expect(row.attempts).toBe(1)
    expect(Date.parse(row.next_attempt_at) - before).toBeGreaterThanOrEqual(119_000)
  })

  it('adds unsent local spend on top of the all-device admin spend', () => {
    const now = new Date()
    const u = new UsageService(db, () => null, () => ({ month_usd: 5, today_usd: 2, month: now.toISOString().slice(0, 7) }), () => undefined)
    record(u)
    u.stop()
    expect(u.merged(now)).toEqual({ today: 2.01, month: 5.01 })
  })
})

describe('config sync Retry-After', () => {
  it('does not call admin again before Retry-After expires', async () => {
    let n = 0
    const fetchMock = vi.fn<FetchLike>(async () => {
      n++
      return n === 1 ? json(200, { device_id: 'a1b2c3d4e5f6', token: TOKEN, config_version: 1 }) : json(429, { error: 'slow', code: 'rate_limited' }, { 'retry-after': '60' })
    })
    const client = new AdminClient({ fetch: fetchMock })
    const pairing = new PairingService({
      client,
      store: new SecureFile<DeviceRecord>(join(dir, 'device.bin'), cipher),
      deviceInfo: () => ({ name: 'PC', os: 'Windows', appVersion: '0.1.0' })
    })
    await pairing.pair('ABCD-EFGH')
    const sync = new ConfigSync({ client, pairing, cache: new SecureFile<CachedConfig>(join(dir, 'config.bin'), cipher) })
    await sync.syncNow()
    await sync.syncNow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sync.status()).toMatchObject({ paired: true, error: expect.stringMatching(/slow/) })
  })
})

describe('main-side surfaces for the renderer', () => {
  it('lists artifacts across chats, newest first, without archived chats', () => {
    const lib = new Library(db)
    const store = new ArtifactStore(db)
    const a = lib.createConversation({ title: 'First' })
    const b = lib.createConversation({ title: 'Second' })
    store.ingest(a.id, 'm1', '```html\n<p>a</p>\n```')
    store.ingest(b.id, 'm2', '```svg\n<svg></svg>\n```')
    const all = store.listAll()
    expect(all.map((x) => x.conversationTitle).sort()).toEqual(['First', 'Second'])
    lib.updateConversation(b.id, { archived: true })
    expect(store.listAll().map((x) => x.conversationTitle)).toEqual(['First'])
    expect(store.listAll(0 + 1)).toHaveLength(1)
  })

  it('builds preview documents only for html and svg', () => {
    expect(previewDocument({ kind: 'html', content: '<script>1</script>' })).toBe('<script>1</script>')
    expect(previewDocument({ kind: 'svg', content: '<svg/>' })).toMatch(/^<!doctype html>.*<svg\/>$/)
    expect(previewDocument({ kind: 'code', content: 'x' })).toBeNull()
  })

  it('stores fontSize with a default of 14', () => {
    const s = new SettingsService(db, dir)
    expect(s.get().fontSize).toBe(14)
    s.set({ fontSize: 16 })
    expect(s.get().fontSize).toBe(16)
    expect(() => s.set({ fontSize: 40 })).toThrow()
  })

  it('skips disabled, keyless or malformed providers (contract note 5)', () => {
    const base = { id: 'c', kind: 'openai-compatible' as const, label: 'C', base_url: 'https://x.test/v1', api_key: 'k', enabled: true }
    expect(usable(base)).toBe(true)
    expect(usable({ ...base, enabled: false })).toBe(false)
    expect(usable({ ...base, api_key: '' })).toBe(false)
    expect(usable({ ...base, base_url: '' })).toBe(false)
  })
})
