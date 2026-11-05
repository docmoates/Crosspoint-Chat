import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { AdminConfig } from '@shared/admin-contract'
import type { AttachmentRef, ChatSendInput, ChatSettings, Message, MessagePart, StreamEvent, UsageInfo } from '@shared/ipc'
import { IMAGE_TOKEN_ESTIMATE, estimateTokens } from '../providers/cost'
import { ProviderError, isAbortError, toProviderError, type ChatProvider, type ChatMessage, type ChatContentPart, type ProviderStreamEvent } from '../providers/types'
import type { ArtifactStore } from './artifacts'
import type { AuditLog } from './audit'
import { VISION_MIME, type FileStore } from './files'
import { textOf, type Library } from './library'
import type { MediaClient } from './media'
import type { SettingsService } from './settings'
import type { UsageService } from './usage'

export interface ChatDeps {
  library: Library
  files: FileStore
  artifacts: ArtifactStore
  usage: UsageService
  /** The admin server, which picks the model. Null when not paired. */
  gateway: () => ChatProvider | null
  media: MediaClient
  data: { ensureFile(id: string, path: string): Promise<void>; run(): Promise<boolean> }
  settings: SettingsService
  audit: AuditLog
  config: () => AdminConfig | null
  emit: (e: StreamEvent) => void
}

interface RunContext {
  runId: string
  conversationId: string
  messageId: string
  parentId: string
  settings: ChatSettings
  controller: AbortController
}

const PROJECT_CONTEXT_MAX_CHARS = 300_000
/** The server chooses the real model for these. */
const AUTO_MODEL = 'auto'
const TITLE_MODEL = 'system:title'
const GATEWAY_ID = 'crosspoint'
const VIDEO_POLL_MS = 10_000
const VIDEO_MAX_MS = 20 * 60_000
const DEFAULT_TITLE_WORDS = 6

export class ChatError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

/** Runs one assistant reply per send: limits, prompt assembly, streaming with fallback, persistence, usage, artifacts, title. */
export class ChatService {
  private runs = new Map<string, RunContext>()

  constructor(private readonly d: ChatDeps) {}

  async send(input: ChatSendInput): Promise<{ messageId: string; runId: string }> {
    const conv = this.d.library.getConversation(input.conversationId)
    this.requirePaired()

    const attachments: AttachmentRef[] = []
    for (const a of input.attachments ?? []) {
      const stored = this.d.files.getAttachment(a.id)
      if (!stored) throw new ChatError(`Attachment ${a.name} is no longer available. Attach it again.`, 'attachment_missing')
      attachments.push({ id: stored.id, name: stored.name, mime: stored.mime, size: stored.size, kind: stored.kind })
    }
    if (!input.text.trim() && attachments.length === 0) throw new ChatError('Type a message or attach a file first.', 'empty')

    const userId = randomUUID()
    const parts: MessagePart[] = []
    if (input.text) parts.push({ type: 'text', text: input.text })
    for (const a of attachments) parts.push({ type: 'attachment', attachment: a })
    this.d.library.insertMessage({
      id: userId,
      conversationId: conv.id,
      role: 'user',
      parts,
      modelId: null,
      provider: null,
      status: 'complete',
      usage: null,
      costUsd: null,
      parentId: null
    })
    for (const a of attachments) this.d.files.linkAttachment(a.id, conv.id, userId)

    return this.startRun(conv.id, userId, { ...conv.settings, ...(input.settings ?? {}) })
  }

  async regenerate(messageId: string): Promise<{ runId: string }> {
    const msg = this.d.library.getMessage(messageId)
    let parentId: string
    let createdAt: string | undefined
    if (msg.role === 'assistant') {
      if (!msg.parentId) throw new ChatError('This reply has no prompt to regenerate from.', 'no_parent')
      parentId = msg.parentId
      createdAt = msg.createdAt
      for (const r of this.runs.values()) if (r.messageId === msg.id) r.controller.abort()
      this.d.library.deleteMessage(msg.id)
    } else if (msg.role === 'user') {
      parentId = msg.id
      const children = this.d.library.listMessages(msg.conversationId).filter((m) => m.parentId === msg.id)
      createdAt = children[0]?.createdAt
      for (const c of children) this.d.library.deleteMessage(c.id)
    } else {
      throw new ChatError('Only chat messages can be regenerated.', 'bad_role')
    }
    const conv = this.d.library.getConversation(msg.conversationId)
    this.requirePaired()
    const { runId } = await this.startRun(conv.id, parentId, conv.settings, createdAt ?? new Date(Date.parse(msg.createdAt) + 1).toISOString())
    return { runId }
  }

  stop(runId: string): void {
    this.runs.get(runId)?.controller.abort()
  }

  stopAll(): void {
    for (const r of this.runs.values()) r.controller.abort()
  }

  private requirePaired(): void {
    if (!this.d.config()) throw new ChatError('Pair this device with admin first.', 'not_paired')
  }

  private async startRun(
    conversationId: string,
    parentId: string,
    settings: ChatSettings,
    createdAt?: string
  ): Promise<{ messageId: string; runId: string }> {
    const messageId = randomUUID()
    const runId = randomUUID()
    this.d.library.insertMessage({
      id: messageId,
      conversationId,
      role: 'assistant',
      parts: [],
      modelId: AUTO_MODEL,
      provider: GATEWAY_ID,
      status: 'streaming',
      usage: null,
      costUsd: null,
      parentId,
      ...(createdAt ? { createdAt } : {})
    })
    const ctx: RunContext = { runId, conversationId, messageId, parentId, settings, controller: new AbortController() }
    this.runs.set(runId, ctx)
    // Let the renderer receive { messageId, runId } before the first event.
    setImmediate(() => {
      void this.run(ctx)
        .catch((err) => this.failRun(ctx, err instanceof Error ? err.message : String(err)))
        .finally(() => this.runs.delete(runId))
    })
    return { messageId, runId }
  }

  private emit(ctx: RunContext, e: ProviderStreamEvent): void {
    this.d.emit({ ...e, runId: ctx.runId, conversationId: ctx.conversationId, messageId: ctx.messageId } as StreamEvent)
  }

  private failRun(ctx: RunContext, message: string): void {
    try {
      this.d.library.updateMessage(ctx.messageId, { parts: [{ type: 'notice', level: 'error', message, code: 'run_failed' }], status: 'error' })
    } catch {
      // the message row may be gone; still tell the renderer
    }
    this.emit(ctx, { type: 'error', code: 'run_failed', message })
    this.emit(ctx, { type: 'done', finishReason: 'error' })
  }

  private async run(ctx: RunContext): Promise<void> {
    const notices: MessagePart[] = []
    const notice = (level: 'info' | 'warn' | 'error', message: string, code?: string): void => {
      notices.push({ type: 'notice', level, message, ...(code ? { code } : {}) })
      this.emit(ctx, { type: 'notice', level, message, ...(code ? { code } : {}) })
    }
    const fail = (message: string, code: string): void => {
      notice('error', message, code)
      this.d.library.updateMessage(ctx.messageId, { parts: notices, status: 'error' })
      this.emit(ctx, { type: 'error', code, message })
      this.emit(ctx, { type: 'done', finishReason: 'error' })
    }

    const cfg = this.d.config()
    if (!cfg) return fail('This device is not paired with admin.', 'not_paired')
    const provider = this.d.gateway()
    if (!provider) return fail('This device is not paired with admin.', 'not_paired')

    const limit = this.d.usage.checkLimits(cfg.limits, this.d.settings.get().dailyCapUsd)
    if (limit.blocked) return fail(limit.blocked.message, limit.blocked.code)

    // Files added on another PC come down before the prompt is built.
    for (const m of this.d.library.listMessages(ctx.conversationId)) {
      for (const p of m.parts) {
        if (p.type !== 'attachment') continue
        const a = this.d.files.getAttachment(p.attachment.id)
        if (a?.kind === 'image') await this.d.data.ensureFile(a.id, a.path).catch(() => undefined)
      }
    }

    let history: ChatMessage[]
    let system: string | undefined
    try {
      history = this.buildHistory(ctx)
      system = this.buildSystem(ctx)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 'prompt_failed')
    }

    const promptTokens =
      estimateTokens(system ?? '') +
      history.reduce((n, m) => n + m.content.reduce((k, p) => k + (p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKEN_ESTIMATE), 0), 0)
    let text = ''
    let thinking = ''
    const toolCalls: MessagePart[] = []
    let usage: UsageInfo | null = null
    let finish: Extract<StreamEvent, { type: 'done' }>['finishReason'] = 'stop'
    let failure: ProviderError | null = null
    const created: MessagePart[] = []

    this.d.audit.append('outbound', 'chat request to the Crosspoint server')
    try {
      const stream = provider.stream(history, {
        model: AUTO_MODEL,
        system,
        maxTokens: ctx.settings.maxTokens,
        signal: ctx.controller.signal
      })
      for await (const ev of stream) {
        if (ev.type === 'text') {
          text += ev.delta
          this.emit(ctx, ev)
        } else if (ev.type === 'thinking') {
          thinking += ev.delta
          this.emit(ctx, ev)
        } else if (ev.type === 'tool_call') {
          toolCalls.push({ type: 'tool_call', id: ev.id, name: ev.name, input: ev.input })
          this.emit(ctx, ev)
        } else if (ev.type === 'media_image') {
          created.push(await this.saveMedia(ctx, ev.base64, ev.mime, mediaName(history)))
          usage = { provider: GATEWAY_ID, model: AUTO_MODEL, tokensIn: 0, tokensOut: 0, cachedTokens: 0, costUsd: ev.costUsd }
        } else if (ev.type === 'media_video') {
          const notice_ = 'Creating your video. This can take a few minutes.'
          notice('info', notice_, 'video_started')
          const costUsd = await this.finishVideo(ctx, ev.jobId, mediaName(history), created)
          usage = { provider: GATEWAY_ID, model: AUTO_MODEL, tokensIn: 0, tokensOut: 0, cachedTokens: 0, costUsd }
        } else if (ev.type === 'usage') {
          usage = ev.usage
        } else if (ev.type === 'done') {
          finish = ev.finishReason
        } else if (ev.type === 'error') {
          throw new ProviderError(ev.message, null, GATEWAY_ID)
        } else {
          this.emit(ctx, ev)
        }
      }
    } catch (err) {
      if (!ctx.controller.signal.aborted && !isAbortError(err)) failure = toProviderError(err, GATEWAY_ID, provider.label)
    }

    const stopped = ctx.controller.signal.aborted
    if (stopped) finish = 'stopped'

    // Usage: provider-reported, or estimated when a stopped stream never reported it.
    if (!usage && (text || thinking) && stopped) {
      const tokensOut = estimateTokens(text + thinking)
      usage = {
        provider: GATEWAY_ID,
        model: AUTO_MODEL,
        tokensIn: promptTokens,
        tokensOut,
        cachedTokens: 0,
        // The server records the real cost of a stopped reply.
        costUsd: 0
      }
      this.d.usage.record({ ...usage, kind: 'chat', conversationId: ctx.conversationId, messageId: ctx.messageId, estimated: true })
      this.emit(ctx, { type: 'usage', usage })
    } else if (usage) {
      this.d.usage.record({ ...usage, kind: created.length ? 'image' : 'chat', conversationId: ctx.conversationId, messageId: ctx.messageId })
      this.emit(ctx, { type: 'usage', usage })
    }

    const parts: MessagePart[] = [...notices]
    if (thinking) parts.push({ type: 'thinking', text: thinking })
    if (text) parts.push({ type: 'text', text })
    parts.push(...toolCalls, ...created)

    if (failure && !text && !stopped) {
      this.d.audit.append('error', `chat failed: ${failure.status ?? 'network'}`)
      parts.push({ type: 'notice', level: 'error', message: failure.message, code: 'provider_error' })
      this.d.library.updateMessage(ctx.messageId, {
        parts,
        status: 'error',
        usage,
        costUsd: usage?.costUsd ?? null
      })
      this.emit(ctx, { type: 'error', code: 'provider_error', message: failure.message })
      this.emit(ctx, { type: 'done', finishReason: 'error' })
      return
    }
    if (failure && text) {
      parts.push({ type: 'notice', level: 'error', message: `The reply was cut off: ${failure.message}`, code: 'provider_error' })
      this.emit(ctx, { type: 'notice', level: 'error', code: 'provider_error', message: `The reply was cut off: ${failure.message}` })
      finish = 'error'
    }

    this.d.library.updateMessage(ctx.messageId, {
      parts,
      status: stopped ? 'stopped' : failure ? 'error' : 'complete',
      usage,
      costUsd: usage?.costUsd ?? null
    })
    if (text) {
      try {
        this.d.artifacts.ingest(ctx.conversationId, ctx.messageId, text)
      } catch {
        // artifact detection must never fail a reply
      }
    }

    void this.d.data.run().catch(() => undefined)
    const title = !stopped && (text || created.length) ? await this.maybeTitle(ctx, text).catch(() => undefined) : undefined
    this.emit(ctx, { type: 'done', finishReason: finish, ...(title ? { title } : {}) })
  }

  /** Saves what the router created on this reply and shows it. */
  private async saveMedia(ctx: RunContext, base64: string, mime: string, name: string): Promise<MessagePart> {
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm' } as Record<string, string>)[mime] ?? 'bin'
    const ref = await this.d.files.addAttachmentFromPaste({ name: `${name || 'created'}.${ext}`, mime, base64 })
    this.d.files.linkAttachment(ref.id, ctx.conversationId, ctx.messageId)
    this.d.emit({ type: 'attachment', attachment: ref, runId: ctx.runId, conversationId: ctx.conversationId, messageId: ctx.messageId } as StreamEvent)
    return { type: 'attachment', attachment: ref }
  }

  /** The router started a video on the server: wait for it, then download it. Returns its cost. */
  private async finishVideo(ctx: RunContext, jobId: string, name: string, out: MessagePart[]): Promise<number> {
    const signal = ctx.controller.signal
    const deadline = Date.now() + VIDEO_MAX_MS
    for (;;) {
      await new Promise((r) => setTimeout(r, VIDEO_POLL_MS))
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError')
      if (Date.now() > deadline) throw new Error('The video took too long. Try again.')
      const s = await this.d.media.pollVideo(jobId, signal).catch((err: unknown) => {
        if (signal.aborted) throw err
        return { status: 'pending', cost_usd: null, error: undefined }
      })
      if (['failed', 'cancelled', 'expired'].includes(s.status)) throw new Error(s.error ?? 'The video could not be created. Try a different prompt.')
      if (s.status === 'completed') {
        const file = await this.d.media.videoContent(jobId, signal)
        out.push(await this.saveMedia(ctx, file.bytes.toString('base64'), file.mime, name))
        return s.cost_usd ?? 0
      }
    }
  }

  private buildHistory(ctx: RunContext): ChatMessage[] {
    const all = this.d.library.listMessages(ctx.conversationId)
    const parentIdx = all.findIndex((m) => m.id === ctx.parentId)
    const slice = parentIdx >= 0 ? all.slice(0, parentIdx + 1) : all.filter((m) => m.id !== ctx.messageId)
    const out: ChatMessage[] = []
    for (const m of slice) {
      if (m.id === ctx.messageId || m.role === 'system') continue
      if (m.role === 'assistant') {
        const t = textOf(m.parts)
        if (t.trim()) out.push({ role: 'assistant', content: [{ type: 'text', text: t }] })
        continue
      }
      out.push({ role: 'user', content: this.userContent(m) })
    }
    while (out.length && out[0]!.role === 'assistant') out.shift()
    return out
  }

  private userContent(m: Message): ChatContentPart[] {
    const content: ChatContentPart[] = []
    const docs: string[] = []
    for (const p of m.parts) {
      if (p.type !== 'attachment') continue
      const a = this.d.files.getAttachment(p.attachment.id)
      if (!a) {
        docs.push(`[attachment ${p.attachment.name} is no longer available]`)
        continue
      }
      if (a.kind === 'image') {
        if (VISION_MIME.has(a.mime) && existsSync(a.path)) content.push({ type: 'image', mime: a.mime, base64: this.d.files.readBase64(a.path) })
        else docs.push(`[image ${a.name} attached; this image type is not supported]`)
      } else if (a.text) {
        docs.push(`<attachment name="${a.name.replace(/"/g, "'")}">\n${a.text}\n</attachment>`)
      } else {
        docs.push(`[attachment ${a.name} (${a.mime}) attached; no text could be extracted]`)
      }
    }
    const t = textOf(m.parts)
    const textBlock = [...docs, t].filter(Boolean).join('\n\n')
    if (textBlock) content.push({ type: 'text', text: textBlock })
    if (content.length === 0) content.push({ type: 'text', text: ' ' })
    return content
  }

  private buildSystem(ctx: RunContext): string | undefined {
    const conv = this.d.library.getConversation(ctx.conversationId)
    const sections: string[] = []
    if (conv.projectId) {
      const project = this.d.library.getProject(conv.projectId)
      if (project.instructions.trim()) sections.push(`Project "${project.name}" instructions:\n${project.instructions.trim()}`)
      let budget = PROJECT_CONTEXT_MAX_CHARS
      const files: string[] = []
      for (const f of this.d.files.projectFileTexts(project.id)) {
        if (budget <= 0) break
        const body = f.text.slice(0, budget)
        budget -= body.length
        files.push(`<project_file name="${f.name.replace(/"/g, "'")}">\n${body}\n</project_file>`)
      }
      if (files.length) sections.push(`Project knowledge files:\n${files.join('\n\n')}`)
    }
    const memories = this.d.library.listMemories()
    if (memories.length) sections.push(`Saved memories about the user:\n${memories.map((m) => `- ${m.text}`).join('\n')}`)
    if (ctx.settings.systemPrompt?.trim()) sections.push(ctx.settings.systemPrompt.trim())
    return sections.length ? sections.join('\n\n') : undefined
  }

  /** After the first assistant reply: a short title from the server's title route, else the first words. */
  private async maybeTitle(ctx: RunContext, reply: string): Promise<string | undefined> {
    if (this.d.library.conversationTitleSource(ctx.conversationId) !== 'none') return undefined
    const msgs = this.d.library.listMessages(ctx.conversationId)
    if (msgs.filter((m) => m.role === 'assistant' && m.status === 'complete').length !== 1) return undefined
    const firstUser = msgs.find((m) => m.role === 'user')
    const userText = firstUser ? textOf(firstUser.parts) : ''
    const fallback = firstWords(userText) || firstUser?.parts.find((p) => p.type === 'attachment')?.attachment.name || 'New chat'

    let title: string | undefined
    const provider = this.d.gateway()
    if (provider) {
      try {
        let out = ''
        let usage: UsageInfo | null = null
        const signal = AbortSignal.timeout(8_000)
        for await (const ev of provider.stream(
          [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `User: ${userText.slice(0, 2_000)}\n\nAssistant: ${reply.slice(0, 1_000)}`
                }
              ]
            }
          ],
          { model: TITLE_MODEL, maxTokens: 40, signal }
        )) {
          if (ev.type === 'text') out += ev.delta
          else if (ev.type === 'usage') usage = ev.usage
        }
        if (usage) this.d.usage.record({ ...usage, kind: 'helper', conversationId: ctx.conversationId, messageId: null })
        title = cleanTitle(out)
      } catch {
        title = undefined
      }
    }
    const final = title || fallback
    this.d.library.setGeneratedTitle(ctx.conversationId, final, title ? 'helper' : 'first_words')
    return final
  }
}

function mediaName(history: ChatMessage[]): string {
  const last = history[history.length - 1]
  const text = last?.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ') ?? ''
  return firstWords(text, 4)
}

export function firstWords(text: string, n = DEFAULT_TITLE_WORDS): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, n).join(' ')
  return words.length > 60 ? `${words.slice(0, 57).trimEnd()}...` : words
}

export function cleanTitle(raw: string): string {
  return raw
    .split('\n')[0]!
    .replace(/^["'`*#\s]+|["'`*\s]+$/g, '')
    .replace(/^title:\s*/i, '')
    .replace(/[.!]+$/, '')
    .slice(0, 80)
    .trim()
}
