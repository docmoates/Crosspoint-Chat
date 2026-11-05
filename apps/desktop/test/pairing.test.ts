import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminClient, type FetchLike } from '../src/main/admin/client'
import { PairingService, type DeviceRecord } from '../src/main/admin/pairing'
import { ConfigSync, type CachedConfig } from '../src/main/admin/sync'
import { SecureFile, type StringCipher } from '../src/main/secure-file'

/** Reversible stand-in for DPAPI: XOR + marker so plaintext never appears in the file. */
const cipher: StringCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.concat([Buffer.from('ENC1'), Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a))]),
  decryptString: (b) => {
    if (b.subarray(0, 4).toString() !== 'ENC1') throw new Error('not encrypted')
    return Buffer.from(b.subarray(4).map((x) => x ^ 0x5a)).toString('utf8')
  }
}

const TOKEN = 'dmd_a1b2c3d4e5f6_abcdefghijklmnopqrstuvwxyzABCDEF'
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const CONFIG = {
  config_version: 7,
  device: { id: 'a1b2c3d4e5f6', name: 'DESKTOP-TEST', created_at: '2026-11-01T00:00:00Z', last_seen_at: null },
  gateway: { path: '/api/devices/me/v1' },
  // Older admin builds still send mcp_servers and sub-chat limits; the parser must ignore them.
  mcp_servers: [{ id: 'gh', name: 'GitHub', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer h' }, enabled: true }],
  limits: { monthly_usd: 100, daily_usd: 5, per_message_warn_usd: 0.5, sub_chat_usd: 2, sub_chat_steps: 20 },
  spend: { month_usd: 12.34, today_usd: 0.56, month: '2026-11' }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crosspoint-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(fetchImpl: FetchLike) {
  const fetchMock = vi.fn(fetchImpl)
  const client = new AdminClient({ fetch: fetchMock })
  const store = new SecureFile<DeviceRecord>(join(dir, 'device.bin'), cipher)
  const pairing = new PairingService({ client, store, deviceInfo: () => ({ name: 'DESKTOP-TEST', os: 'Windows 11 10.0.28000', appVersion: '0.1.0' }) })
  return { fetchMock, client, store, pairing }
}

describe('pairing', () => {
  it('posts the code to the admin host and stores the token encrypted', async () => {
    const { fetchMock, pairing, store } = setup(async () => json(200, { device_id: 'a1b2c3d4e5f6', token: TOKEN, config_version: 1 }))
    const res = await pairing.pair(' abcd efgh ')
    expect(res).toEqual({ ok: true })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://admin.docmoates.com/api/devices/pair')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'ABCD-EFGH', name: 'DESKTOP-TEST', os: 'Windows 11 10.0.28000', app_version: '0.1.0' })

    const raw = readFileSync(store.path)
    expect(raw.includes(Buffer.from(TOKEN))).toBe(false)
    expect(store.read()).toMatchObject({ host: 'admin.docmoates.com', deviceId: 'a1b2c3d4e5f6', token: TOKEN })

    // A fresh service reads the same device back from disk.
    const again = new PairingService({ client: new AdminClient({ fetch: fetchMock }), store, deviceInfo: () => ({ name: 'x', os: 'y', appVersion: 'z' }) })
    expect(again.isPaired()).toBe(true)
    expect(again.token).toBe(TOKEN)

    again.unpair()
    expect(store.exists()).toBe(false)
    expect(again.token).toBeNull()
  })

  it('honours a custom host from a deep link', async () => {
    const { fetchMock, pairing } = setup(async () => json(200, { device_id: 'a1b2c3d4e5f6', token: TOKEN, config_version: 1 }))
    await pairing.pair('ABCD-EFGH', 'https://staging.admin.example.com/')
    expect(fetchMock.mock.calls[0]![0]).toBe('https://staging.admin.example.com/api/devices/pair')
    expect(pairing.host).toBe('staging.admin.example.com')
  })

  it('rejects malformed codes without a network call', async () => {
    const { fetchMock, pairing } = setup(async () => json(200, {}))
    const res = await pairing.pair('ABC-123')
    expect(res.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains bad codes, rate limits, HTML answers and network failures', async () => {
    const bad = setup(async () => json(400, { error: 'bad code', code: 'bad_code' }))
    expect(await bad.pairing.pair('ABCD-EFGH')).toEqual({ ok: false, error: 'bad code' })
    expect(bad.store.exists()).toBe(false)

    const limited = setup(async () => json(429, { error: 'slow down', code: 'rate_limited' }))
    expect(await limited.pairing.pair('ABCD-EFGH')).toEqual({ ok: false, error: expect.stringMatching(/Too many/) })

    const html = setup(async () => new Response('<html>Not allowed</html>', { status: 403, headers: { 'content-type': 'text/html' } }))
    expect(await html.pairing.pair('ABCD-EFGH')).toEqual({ ok: false, error: expect.stringMatching(/HTTP 403 without a JSON error/) })

    const offline = setup(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await offline.pairing.pair('ABCD-EFGH')).toEqual({ ok: false, error: expect.stringMatching(/Could not reach admin\.docmoates\.com/) })
  })

  it('rejects a response with a malformed token', async () => {
    const { pairing, store } = setup(async () => json(200, { device_id: 'a1b2c3d4e5f6', token: 'nope', config_version: 1 }))
    const res = await pairing.pair('ABCD-EFGH')
    expect(res.ok).toBe(false)
    expect(store.exists()).toBe(false)
  })
})

describe('config sync', () => {
  async function paired(fetchImpl: FetchLike) {
    const calls: { url: string; init?: RequestInit }[] = []
    let impl: FetchLike = async () => json(200, { device_id: 'a1b2c3d4e5f6', token: TOKEN, config_version: 1 })
    const ctx = setup(async (url, init) => {
      calls.push({ url, init })
      return impl(url, init)
    })
    await ctx.pairing.pair('ABCD-EFGH')
    impl = fetchImpl
    const cache = new SecureFile<CachedConfig>(join(dir, 'config.bin'), cipher)
    const wiped = vi.fn()
    const sync = new ConfigSync({ client: ctx.client, pairing: ctx.pairing, cache, onWipe: wiped })
    return { ...ctx, calls, cache, sync, wiped }
  }

  it('pulls config, sends If-None-Match next time and caches encrypted', async () => {
    let n = 0
    const { sync, calls, cache } = await paired(async () => (n++ === 0 ? json(200, CONFIG) : new Response(null, { status: 304 })))
    await sync.syncNow()
    expect(sync.full?.gateway.path).toBe('/api/devices/me/v1')
    const view = sync.sanitized()
    expect(JSON.stringify(view)).not.toMatch(/secret|Bearer/)
    expect(view.limits.monthly_usd).toBe(100)

    await sync.syncNow()
    const second = new Headers(calls.at(-1)!.init?.headers)
    expect(second.get('if-none-match')).toBe('"7"')
    expect(second.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(sync.status()).toMatchObject({ paired: true, device: { id: 'a1b2c3d4e5f6', name: 'DESKTOP-TEST' } })
    expect(readFileSync(cache.path).includes(Buffer.from(TOKEN))).toBe(false)
    expect(cache.read()?.config.config_version).toBe(7)
  })

  it('wipes token, keys and cache on 401 revoked', async () => {
    let n = 0
    const { sync, store, cache, wiped } = await paired(async () => (n++ === 0 ? json(200, CONFIG) : json(401, { error: 'revoked', code: 'revoked' })))
    await sync.syncNow()
    expect(cache.exists()).toBe(true)
    const statuses: unknown[] = []
    sync.on('status', (s) => statuses.push(s))
    await sync.syncNow()
    expect(sync.full).toBeNull()
    expect(store.exists()).toBe(false)
    expect(cache.exists()).toBe(false)
    expect(wiped).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toMatchObject({ paired: false, error: expect.stringMatching(/revoked/) })
  })

  it('keeps the cached config when admin is unreachable', async () => {
    let n = 0
    const { sync } = await paired(async () => {
      if (n++ === 0) return json(200, CONFIG)
      throw new TypeError('fetch failed')
    })
    await sync.syncNow()
    await sync.syncNow()
    expect(sync.full?.config_version).toBe(7)
    expect(sync.status()).toMatchObject({ paired: true, error: expect.stringMatching(/unreachable.*cached config/) })
  })

  it('reports a redirect to the HTML console instead of following it', async () => {
    const { sync, calls } = await paired(async () => new Response(null, { status: 303, headers: { location: '/signin' } }))
    await sync.syncNow()
    expect(calls.at(-1)!.init?.redirect).toBe('manual')
    expect(sync.status().error).toMatch(/redirected the request \(HTTP 303\)/)
  })
})
