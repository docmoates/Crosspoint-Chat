import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { AttachmentRef, PasteData, ProjectFile } from '@shared/ipc'
import { nowIso, type DB } from '../db'

const MAX_FILE_BYTES = 50 * 1024 * 1024
/** Extracted text is capped per file so one document cannot blow the context window. */
export const MAX_TEXT_CHARS = 400_000

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.log': 'text/plain'
}

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.css', '.yaml', '.yml', '.log', '.ini', '.toml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.sh', '.ps1', '.bat', '.sql', '.svg', '.vue', '.svelte', '.swift', '.r', '.lua', '.tex', '.env.example'
])

/** Vision APIs accept these; other image types are stored but sent as a note. */
export const VISION_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function mimeFor(name: string): string {
  const ext = extname(name).toLowerCase()
  return MIME[ext] ?? (TEXT_EXT.has(ext) ? 'text/plain' : 'application/octet-stream')
}

export function kindFor(name: string, mime: string): AttachmentRef['kind'] {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || TEXT_EXT.has(extname(name).toLowerCase())) return 'text'
  return 'file'
}

export async function extractText(path: string, kind: AttachmentRef['kind']): Promise<string | null> {
  try {
    if (kind === 'text') {
      const text = readFileSync(path, 'utf8')
      return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated at ${MAX_TEXT_CHARS} characters]` : text
    }
    if (kind === 'pdf') {
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: readFileSync(path) })
      try {
        const res = await parser.getText()
        const text = res.text.trim()
        return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated at ${MAX_TEXT_CHARS} characters]` : text
      } finally {
        await parser.destroy().catch(() => undefined)
      }
    }
  } catch {
    return null
  }
  return null
}

interface AttachmentRow {
  id: string
  name: string
  mime: string
  size: number
  kind: AttachmentRef['kind']
  path: string
  text: string | null
}

/** Copies user files into `%APPDATA%\Crosspoint\attachments\<id>\` and extracts text for the model. */
export class FileStore {
  constructor(
    private readonly db: DB,
    private readonly attachmentsDir: string,
    private readonly projectFilesDir: string
  ) {}

  async addAttachmentFromPath(src: string): Promise<AttachmentRef> {
    const st = statSync(src)
    if (!st.isFile()) throw new Error(`${basename(src)} is not a file`)
    if (st.size > MAX_FILE_BYTES) throw new Error(`${basename(src)} is larger than 50 MB`)
    const id = randomUUID()
    const name = basename(src)
    const dest = join(this.attachmentsDir, id, sanitizeName(name))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    return this.insertAttachment(id, name, mimeFor(name), st.size, dest)
  }

  async addAttachmentFromPaste(data: PasteData): Promise<AttachmentRef> {
    const buf = Buffer.from(data.base64, 'base64')
    if (buf.length > MAX_FILE_BYTES) throw new Error('Pasted file is larger than 50 MB')
    const id = randomUUID()
    const dest = join(this.attachmentsDir, id, sanitizeName(data.name))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf)
    const mime = data.mime || mimeFor(data.name)
    return this.insertAttachment(id, data.name, mime, buf.length, dest)
  }

  getAttachment(id: string): (AttachmentRef & { path: string; text: string | null }) | null {
    const row = this.db.prepare('SELECT id, name, mime, size, kind, path, text FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined
    return row ? { id: row.id, name: row.name, mime: row.mime, size: row.size, kind: row.kind, path: row.path, text: row.text } : null
  }

  linkAttachment(id: string, conversationId: string, messageId: string): void {
    this.db.prepare('UPDATE attachments SET conversation_id = ?, message_id = ? WHERE id = ?').run(conversationId, messageId, id)
  }

  readBase64(path: string): string {
    return readFileSync(path).toString('base64')
  }

  // ---------- project files ----------

  async addProjectFile(projectId: string, src: string): Promise<ProjectFile> {
    const st = statSync(src)
    if (!st.isFile()) throw new Error(`${basename(src)} is not a file`)
    if (st.size > MAX_FILE_BYTES) throw new Error(`${basename(src)} is larger than 50 MB`)
    const id = randomUUID()
    const name = basename(src)
    const dest = join(this.projectFilesDir, projectId, id, sanitizeName(name))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    const mime = mimeFor(name)
    const text = await extractText(dest, kindFor(name, mime))
    const createdAt = nowIso()
    this.db
      .prepare('INSERT INTO project_files (id, project_id, name, mime, size, path, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, name, mime, st.size, dest, text, createdAt)
    return { id, projectId, name, mime, size: st.size, textChars: text?.length ?? 0, createdAt }
  }

  listProjectFiles(projectId: string): ProjectFile[] {
    const rows = this.db
      .prepare('SELECT id, project_id, name, mime, size, length(text) AS chars, created_at FROM project_files WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as { id: string; project_id: string; name: string; mime: string; size: number; chars: number | null; created_at: string }[]
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, name: r.name, mime: r.mime, size: r.size, textChars: r.chars ?? 0, createdAt: r.created_at }))
  }

  projectFileTexts(projectId: string): { name: string; text: string }[] {
    return (
      this.db.prepare('SELECT name, text FROM project_files WHERE project_id = ? AND text IS NOT NULL ORDER BY created_at').all(projectId) as {
        name: string
        text: string
      }[]
    ).filter((r) => r.text.trim().length > 0)
  }

  removeProjectFile(id: string): void {
    const row = this.db.prepare('SELECT path FROM project_files WHERE id = ?').get(id) as { path: string } | undefined
    this.db.prepare('DELETE FROM project_files WHERE id = ?').run(id)
    if (row) removeQuietly(dirname(row.path))
  }

  removeFiles(paths: string[]): void {
    for (const p of paths) removeQuietly(dirname(p))
  }

  private async insertAttachment(id: string, name: string, mime: string, size: number, path: string): Promise<AttachmentRef> {
    const kind = kindFor(name, mime)
    const text = await extractText(path, kind)
    this.db
      .prepare('INSERT INTO attachments (id, name, mime, size, kind, path, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, mime, size, kind, path, text, nowIso())
    return { id, name, mime, size, kind }
  }
}

function sanitizeName(name: string): string {
  const clean = basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return clean.slice(0, 180) || 'file'
}

function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}
