import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DB } from '../src/main/db'
import { DataSync, type DataSyncRemote, type SyncRow } from '../src/main/services/data-sync'
import { FileStore } from '../src/main/services/files'
import { Library } from '../src/main/services/library'

/** A stand-in for the server: numbered rows plus files. */
function fakeServer() {
  const rows = new Map<string, SyncRow & { seq: number }>()
  const files = new Map<string, Buffer>()
  let seq = 0
  const remote: DataSyncRemote = {
    push: async (list) => {
      for (const r of list) rows.set(`${r.tbl}/${r.id}`, { ...r, seq: ++seq })
    },
    pull: async (since) => ({ rows: [...rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq), more: false }),
    putFile: async (id, bytes) => void files.set(id, bytes),
    getFile: async (id) => files.get(id)!
  }
  return { remote, rows, files }
}

let dir: string
const dbs: DB[] = []
function device(server: DataSyncRemote | null, name: string) {
  const db = openDatabase(join(dir, `${name}.sqlite`))
  dbs.push(db)
  const dirs = { attachments: join(dir, name, 'att'), projectFiles: join(dir, name, 'pf') }
  return { db, library: new Library(db), files: new FileStore(db, dirs.attachments, dirs.projectFiles), data: new DataSync(db, () => server, dirs) }
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crosspoint-sync-'))
})
afterEach(() => {
  for (const d of dbs.splice(0)) d.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('data sync', () => {
  it('carries chats, messages and memory to a second device, and deletes too', async () => {
    const s = fakeServer()
    const a = device(s.remote, 'a')
    const b = device(s.remote, 'b')
    const conv = a.library.createConversation({ title: 'Trip' })
    a.library.insertMessage({ id: 'm1', conversationId: conv.id, role: 'user', parts: [{ type: 'text', text: 'hello' }], modelId: null, provider: null, status: 'complete', usage: null, costUsd: null, parentId: null })
    a.library.addMemory('likes tea')
    await a.data.run()
    expect(await b.data.run()).toBe(true)
    expect(b.library.getConversation(conv.id).title).toBe('Trip')
    expect(b.library.listMessages(conv.id)[0]?.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(b.library.listMemories()[0]?.text).toBe('likes tea')

    // Rows that arrive are not sent back.
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get()).toEqual({ n: 0 })

    b.library.removeConversation(conv.id)
    await b.data.run()
    await a.data.run()
    expect(a.library.listConversations()).toEqual([])
    expect(a.library.listMessages(conv.id)).toEqual([])
  })

  it('keeps unsent changes when the server is down, and sends them later', async () => {
    const s = fakeServer()
    const down: DataSyncRemote = { ...s.remote, push: async () => { throw new Error('offline') } }
    let remote = down
    const db = openDatabase(join(dir, 'x.sqlite'))
    dbs.push(db)
    const library = new Library(db)
    const data = new DataSync(db, () => remote, { attachments: join(dir, 'xa'), projectFiles: join(dir, 'xp') })
    library.addMemory('keep me')
    await expect(data.run()).rejects.toThrow('offline')
    expect(s.rows.size).toBe(0)
    remote = s.remote
    await data.run()
    expect(s.rows.size).toBe(1)
  })

  it('uploads a file once and downloads it on the other device on demand', async () => {
    const s = fakeServer()
    const a = device(s.remote, 'a')
    const b = device(s.remote, 'b')
    const ref = await a.files.addAttachmentFromPaste({ name: 'n.txt', mime: 'text/plain', base64: Buffer.from('hi').toString('base64') })
    await a.data.run()
    expect(s.files.get(ref.id)?.toString()).toBe('hi')
    expect(JSON.stringify(s.rows.get(`attachments/${ref.id}`)?.data)).not.toContain(dir.replace(/\\/g, '\\\\'))
    await b.data.run()
    const got = b.files.getAttachment(ref.id)!
    expect(existsSync(got.path)).toBe(false)
    await b.data.ensureFile(ref.id, got.path)
    expect(b.files.readBase64(got.path)).toBe(Buffer.from('hi').toString('base64'))
  })

  it('sign-out removes the local copy and does not tell the server to delete it', async () => {
    const s = fakeServer()
    const a = device(s.remote, 'a')
    a.library.addMemory('private')
    await a.data.run()
    a.data.wipe()
    expect(a.library.listMemories()).toEqual([])
    expect(a.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get()).toEqual({ n: 0 })
    await a.data.run()
    expect(a.library.listMemories()[0]?.text).toBe('private')
  })
})
