import { randomUUID } from 'node:crypto'
import type {
  ChatSettings,
  Conversation,
  ConversationCreateInput,
  ConversationListQuery,
  ConversationPatch,
  ConversationSummary,
  Memory,
  Message,
  MessagePart,
  Project,
  ProjectPatch,
  UsageInfo
} from '@shared/ipc'
import { nowIso, parseJson, type DB } from '../db'

interface ConversationRow {
  id: string
  project_id: string | null
  title: string
  title_source: string
  model_id: string | null
  settings: string
  pinned: number
  archived: number
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  conversation_id: string
  parent_id: string | null
  role: Message['role']
  parts: string
  model_id: string | null
  provider: string | null
  status: Message['status']
  usage: string | null
  cost_usd: number | null
  created_at: string
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`)
    this.name = 'NotFoundError'
  }
}

/** Conversations, messages, projects and memories. */
export class Library {
  constructor(private readonly db: DB) {}

  // ---------- conversations ----------

  listConversations(q?: ConversationListQuery): ConversationSummary[] {
    const where: string[] = []
    const args: unknown[] = []
    if (q?.projectId) {
      where.push('c.project_id = ?')
      args.push(q.projectId)
    }
    if (q?.search?.trim()) {
      const like = `%${q.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      where.push(`(c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages s WHERE s.conversation_id = c.id AND s.parts LIKE ? ESCAPE '\\'))`)
      args.push(like, like)
    }
    const sql = `
      SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
             (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at,
             (SELECT parts FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_parts
      FROM conversations c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ?`
    args.push(q?.limit ?? 500)
    const rows = this.db.prepare(sql).all(...args) as (ConversationRow & { message_count: number; last_message_at: string | null; last_parts: string | null })[]
    return rows.map((r) => ({
      ...toConversation(r),
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at,
      preview: textOf(parseJson<MessagePart[]>(r.last_parts, [])).slice(0, 200)
    }))
  }

  getConversation(id: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined
    if (!row) throw new NotFoundError('Conversation')
    return toConversation(row)
  }

  conversationTitleSource(id: string): string {
    const row = this.db.prepare('SELECT title_source FROM conversations WHERE id = ?').get(id) as { title_source: string } | undefined
    return row?.title_source ?? 'none'
  }

  createConversation(input?: ConversationCreateInput): Conversation {
    const now = nowIso()
    const id = randomUUID()
    if (input?.projectId) this.getProject(input.projectId)
    this.db
      .prepare(
        'INSERT INTO conversations (id, project_id, title, title_source, model_id, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input?.projectId ?? null, input?.title ?? '', input?.title ? 'user' : 'none', input?.modelId ?? null, '{}', now, now)
    return this.getConversation(id)
  }

  updateConversation(id: string, patch: ConversationPatch): void {
    this.getConversation(id)
    const sets: string[] = []
    const args: unknown[] = []
    const add = (col: string, v: unknown): void => {
      sets.push(`${col} = ?`)
      args.push(v)
    }
    if (patch.title !== undefined) {
      add('title', patch.title)
      add('title_source', 'user')
    }
    if (patch.modelId !== undefined) add('model_id', patch.modelId)
    if (patch.settings !== undefined) add('settings', JSON.stringify(patch.settings))
    if (patch.pinned !== undefined) add('pinned', patch.pinned ? 1 : 0)
    if (patch.archived !== undefined) add('archived', patch.archived ? 1 : 0)
    if (patch.projectId !== undefined) {
      if (patch.projectId) this.getProject(patch.projectId)
      add('project_id', patch.projectId)
    }
    if (sets.length === 0) return
    add('updated_at', nowIso())
    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  }

  setGeneratedTitle(id: string, title: string, source: 'helper' | 'first_words'): void {
    this.db.prepare(`UPDATE conversations SET title = ?, title_source = ? WHERE id = ? AND title_source != 'user'`).run(title, source, id)
  }

  touchConversation(id: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(nowIso(), id)
  }

  removeConversation(id: string): string[] {
    const files = this.db.prepare('SELECT path FROM attachments WHERE conversation_id = ?').all(id) as { path: string }[]
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    return files.map((f) => f.path)
  }

  // ---------- messages ----------

  listMessages(conversationId: string): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC').all(conversationId) as MessageRow[]
    return rows.map(toMessage)
  }

  getMessage(id: string): Message {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    if (!row) throw new NotFoundError('Message')
    return toMessage(row)
  }

  insertMessage(m: Omit<Message, 'createdAt'> & { createdAt?: string }): Message {
    const createdAt = m.createdAt ?? nowIso()
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, parent_id, role, parts, model_id, provider, status, usage, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.conversationId,
        m.parentId,
        m.role,
        JSON.stringify(m.parts),
        m.modelId,
        m.provider,
        m.status,
        m.usage ? JSON.stringify(m.usage) : null,
        m.costUsd,
        createdAt
      )
    this.touchConversation(m.conversationId)
    return { ...m, createdAt }
  }

  updateMessage(
    id: string,
    patch: Partial<{ parts: MessagePart[]; status: Message['status']; usage: UsageInfo | null; costUsd: number | null; modelId: string | null; provider: string | null }>
  ): void {
    const sets: string[] = []
    const args: unknown[] = []
    if (patch.parts !== undefined) (sets.push('parts = ?'), args.push(JSON.stringify(patch.parts)))
    if (patch.status !== undefined) (sets.push('status = ?'), args.push(patch.status))
    if (patch.usage !== undefined) (sets.push('usage = ?'), args.push(patch.usage ? JSON.stringify(patch.usage) : null))
    if (patch.costUsd !== undefined) (sets.push('cost_usd = ?'), args.push(patch.costUsd))
    if (patch.modelId !== undefined) (sets.push('model_id = ?'), args.push(patch.modelId))
    if (patch.provider !== undefined) (sets.push('provider = ?'), args.push(patch.provider))
    if (sets.length) this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  }

  deleteMessage(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  /** Mark any message left `streaming` by a crash as stopped. */
  recoverInterrupted(): void {
    this.db.prepare(`UPDATE messages SET status = 'stopped' WHERE status = 'streaming'`).run()
  }

  // ---------- projects ----------

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]).map(toProject)
  }

  getProject(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    if (!row) throw new NotFoundError('Project')
    return toProject(row)
  }

  createProject(p: { name: string; instructions?: string }): Project {
    const id = randomUUID()
    const now = nowIso()
    this.db.prepare('INSERT INTO projects (id, name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, p.name, p.instructions ?? '', now, now)
    return this.getProject(id)
  }

  updateProject(id: string, patch: ProjectPatch): void {
    const cur = this.getProject(id)
    this.db
      .prepare('UPDATE projects SET name = ?, instructions = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? cur.name, patch.instructions ?? cur.instructions, nowIso(), id)
  }

  removeProject(id: string): string[] {
    const files = this.db.prepare('SELECT path FROM project_files WHERE project_id = ?').all(id) as { path: string }[]
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return files.map((f) => f.path)
  }

  // ---------- memories ----------

  listMemories(): Memory[] {
    return (this.db.prepare('SELECT id, text, source, created_at FROM memories ORDER BY created_at DESC').all() as MemoryRow[]).map((r) => ({
      id: r.id,
      text: r.text,
      source: r.source,
      createdAt: r.created_at
    }))
  }

  addMemory(text: string, source: Memory['source'] = 'user'): Memory {
    const m: Memory = { id: randomUUID(), text: text.trim(), source, createdAt: nowIso() }
    this.db.prepare('INSERT INTO memories (id, text, source, created_at) VALUES (?, ?, ?, ?)').run(m.id, m.text, m.source, m.createdAt)
    return m
  }

  removeMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }
}

interface ProjectRow {
  id: string
  name: string
  instructions: string
  created_at: string
  updated_at: string
}
interface MemoryRow {
  id: string
  text: string
  source: Memory['source']
  created_at: string
}

function toProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, instructions: r.instructions, createdAt: r.created_at, updatedAt: r.updated_at }
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    modelId: r.model_id,
    settings: parseJson<ChatSettings>(r.settings, {}),
    pinned: !!r.pinned,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    parts: parseJson<MessagePart[]>(r.parts, []),
    modelId: r.model_id,
    provider: r.provider,
    status: r.status,
    usage: parseJson<UsageInfo | null>(r.usage, null),
    costUsd: r.cost_usd,
    parentId: r.parent_id,
    createdAt: r.created_at
  }
}

export function textOf(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}
