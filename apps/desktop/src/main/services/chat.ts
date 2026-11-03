import { randomUUID } from 'node:crypto'
import type { AdminConfig } from '@shared/admin-contract'
import type { AttachmentRef, ChatSendInput, ChatSettings, Message, MessagePart, StreamEvent, UsageInfo } from '@shared/ipc'
import { IMAGE_TOKEN_ESTIMATE, computeCost, estimateCost, estimateTokens } from '../providers/cost'
import type { ProviderRegistry } from '../providers/registry'
import { ProviderError, isAbortError, toProviderError, type ChatMessage, type ChatContentPart, type ProviderStreamEvent } from '../providers/types'
import type { ArtifactStore } from './artifacts'
import type { AuditLog } from './audit'
import { VISION_MIME, type FileStore } from './files'
import { textOf, type Library } from './library'
import type { ModelCatalog, ResolvedModel } from './models'
import type { SettingsService } from './settings'
import type { UsageService } from './usage'

export interface ChatDeps {
  library: Library
  files: FileStore
  artifacts: ArtifactStore
  usage: UsageService
  catalog: ModelCatalog
  registry: ProviderRegistry
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
  modelId: string
  settings: ChatSettings
  controller: AbortController
}

const PROJECT_CONTEXT_MAX_CHARS = 300_000
const EXPECTED_OUTPUT_TOKENS = 1_000
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
    const modelId = this.pickModel(input.modelId ?? conv.modelId)
    if (input.modelId && input.modelId !== conv.modelId) this.d.library.updateConversation(conv.id, { modelId: input.modelId })

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

    return this.startRun(conv.id, userId, modelId, { ...conv.settings, ...(input.settings ?? {}) })
  }

  async regenerate(messageId: string, modelId?: string): Promise<{ runId: string }> {
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
    const chosen = this.pickModel(modelId ?? msg.modelId ?? conv.modelId)
    const { runId } = await this.startRun(conv.id, parentId, chosen, conv.settings, createdAt ?? new Date(Date.parse(msg.createdAt) + 1).toISOString())
    return { runId }
  }

  stop(runId: string): void {
    this.runs.get(runId)?.controller.abort()
  }

  stopAll(): void {
    for (const r of this.runs.values()) r.controller.abort()
  }

  private pickModel(preferred: string | null | undefined): string {
    const cfg = this.d.config()
    if (!cfg) throw new ChatError('Pair this device with admin first; models and keys come from there.', 'not_paired')
    const id = preferred || this.d.settings.get().defaultModelOverride || cfg.default_models.chat
    if (!id) throw new ChatError('Choose a model first. No default chat model is set in admin.', 'no_model')
    return id
  }

  private async startRun(
    conversationId: string,
    parentId: string,
    modelId: string,
    settings: ChatSettings,
    createdAt?: string
  ): Promise<{ messageId: string; runId: string }> {
    const resolved = this.d.catalog.resolve(modelId)
    const messageId = randomUUID()
    const runId = randomUUID()
    this.d.library.insertMessage({
      id: messageId,
      conversationId,
      role: 'assistant',
      parts: [],
      modelId,
      provider: resolved?.providerId ?? null,
      status: 'streaming',
      usage: null,
      costUsd: null,
      parentId,
      ...(createdAt ? { createdAt } : {})
    })
    const ctx: RunContext = { runId, conversationId, messageId, parentId, modelId, settings, controller: new AbortController() }
    this.runs.set(runId, ctx)
    // Let the renderer receive { messageId, runId } before the first event.
    setImmediate(() => {
      void this.run(ctx, resolved).finally(() => this.runs.delete(runId))
    })
    return { messageId, runId }
  }

  private emit(ctx: RunContext, e: ProviderStreamEvent): void {
    this.d.emit({ ...e, runId: ctx.runId, conversationId: ctx.conversationId, messageId: ctx.messageId } as StreamEvent)
  }

  private async run(ctx: RunContext, resolved: ResolvedModel | null): Promise<void> {
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
    if (!resolved) return fail(`Model "${ctx.modelId}" is not available on this device. Check allowed models and providers in admin.`, 'model_unavailable')

    const limit = this.d.usage.checkLimits(cfg.limits, this.d.settings.get().dailyCapUsd)
    if (limit.blocked) return fail(limit.blocked.message, limit.blocked.code)

    let history: ChatMessage[]
    let system: string | undefined
    try {
      history = this.buildHistory(ctx, resolved)
      system = this.buildSystem(ctx)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 'prompt_failed')
    }

    const promptTokens =
      estimateTokens(system ?? '') +
      history.reduce((n, m) => n + m.content.reduce((k, p) => k + (p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKEN_ESTIMATE), 0), 0)
    const estimate = estimateCost(resolved.info?.pricing, promptTokens, Math.min(ctx.settings.maxTokens ?? EXPECTED_OUTPUT_TOKENS, EXPECTED_OUTPUT_TOKENS))
    const warnAt = cfg.limits.per_message_warn_usd
    if (warnAt != null && estimate > warnAt) {
      notice('warn', `This message is estimated at about $${estimate.toFixed(2)}, above the $${warnAt.toFixed(2)} warning level.`, 'cost_warning')
    }

    const candidates = [resolved, ...this.d.catalog.fallbacks(resolved)]
    let text = ''
    let thinking = ''
    const toolCalls: MessagePart[] = []
    let usage: UsageInfo | null = null
    let finish: Extract<StreamEvent, { type: 'done' }>['finishReason'] = 'stop'
    let used: ResolvedModel = resolved
    let failure: ProviderError | null = null
    let attempted = false

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i]!
      const provider = this.d.registry.get(cand.providerId)
      if (!provider) continue
      attempted = true
      used = cand
      failure = null
      let produced = false
      this.d.audit.append('outbound', `chat request to ${provider.label} (${cand.model})`)
      try {
        const stream = provider.stream(history, {
          model: cand.model,
          system,
          maxTokens: ctx.settings.maxTokens,
          temperature: ctx.settings.temperature,
          thinking: ctx.settings.thinking,
          supportsReasoning: cand.info?.capabilities.reasoning ?? false,
          pricing: cand.info?.pricing,
          signal: ctx.controller.signal
        })
        for await (const ev of stream) {
          if (ev.type === 'text') {
            produced = true
            text += ev.delta
            this.emit(ctx, ev)
          } else if (ev.type === 'thinking') {
            produced = true
            thinking += ev.delta
            this.emit(ctx, ev)
          } else if (ev.type === 'tool_call') {
            produced = true
            toolCalls.push({ type: 'tool_call', id: ev.id, name: ev.name, input: ev.input })
            this.emit(ctx, ev)
          } else if (ev.type === 'usage') {
            usage = ev.usage
          } else if (ev.type === 'done') {
            finish = ev.finishReason
          } else if (ev.type === 'error') {
            throw new ProviderError(ev.message, null, cand.providerId)
          } else {
            this.emit(ctx, ev)
          }
        }
        break
      } catch (err) {
        if (ctx.controller.signal.aborted || isAbortError(err)) break
        failure = toProviderError(err, cand.providerId, provider.label)
        const next = candidates.slice(i + 1).find((c) => this.d.registry.get(c.providerId))
        if (!produced && failure.retryable && next) {
          const nextLabel = this.d.registry.get(next.providerId)?.label ?? next.providerId
          notice('info', `${provider.label} failed (${failure.status ?? 'no response'}); retrying on ${nextLabel} with ${next.model}.`, 'fallback')
          continue
        }
        break
      }
    }

    if (!attempted) return fail(`Provider "${resolved.providerId}" is disabled or has no key in admin.`, 'provider_unavailable')

    const stopped = ctx.controller.signal.aborted
    if (stopped) finish = 'stopped'

    // Usage: provider-reported, or estimated when a stopped stream never reported it.
    if (!usage && (text || thinking) && stopped) {
      const tokensOut = estimateTokens(text + thinking)
      usage = {
        provider: used.providerId,
        model: used.model,
        tokensIn: promptTokens,
        tokensOut,
        cachedTokens: 0,
        costUsd: computeCost(used.info?.pricing, { tokensIn: promptTokens, tokensOut, cachedTokens: 0 })
      }
      this.d.usage.record({ ...usage, kind: 'chat', conversationId: ctx.conversationId, messageId: ctx.messageId, estimated: true })
      this.emit(ctx, { type: 'usage', usage })
    } else if (usage) {
      this.d.usage.record({ ...usage, kind: 'chat', conversationId: ctx.conversationId, messageId: ctx.messageId })
      this.emit(ctx, { type: 'usage', usage })
    }

    const parts: MessagePart[] = [...notices]
    if (thinking) parts.push({ type: 'thinking', text: thinking })
    if (text) parts.push({ type: 'text', text })
    parts.push(...toolCalls)

    if (failure && !text && !stopped) {
      this.d.audit.append('error', `chat failed on ${used.providerId}: ${failure.status ?? 'network'}`)
      parts.push({ type: 'notice', level: 'error', message: failure.message, code: 'provider_error' })
      this.d.library.updateMessage(ctx.messageId, {
        parts,
        status: 'error',
        usage,
        costUsd: usage?.costUsd ?? null,
        modelId: used.modelId,
        provider: used.providerId
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
      costUsd: usage?.costUsd ?? null,
      modelId: used.modelId,
      provider: used.providerId
    })
    if (text) {
      try {
        this.d.artifacts.ingest(ctx.conversationId, ctx.messageId, text)
      } catch {
        // artifact detection must never fail a reply
      }
    }

    const title = !stopped && text ? await this.maybeTitle(ctx, text).catch(() => undefined) : undefined
    this.emit(ctx, { type: 'done', finishReason: finish, ...(title ? { title } : {}) })
  }

  private buildHistory(ctx: RunContext, resolved: ResolvedModel): ChatMessage[] {
    const all = this.d.library.listMessages(ctx.conversationId)
    const parentIdx = all.findIndex((m) => m.id === ctx.parentId)
    const slice = parentIdx >= 0 ? all.slice(0, parentIdx + 1) : all.filter((m) => m.id !== ctx.messageId)
    const vision = resolved.info?.capabilities.vision ?? true
    const out: ChatMessage[] = []
    for (const m of slice) {
      if (m.id === ctx.messageId || m.role === 'system') continue
      if (m.role === 'assistant') {
        const t = textOf(m.parts)
        if (t.trim()) out.push({ role: 'assistant', content: [{ type: 'text', text: t }] })
        continue
      }
      out.push({ role: 'user', content: this.userContent(m, vision) })
    }
    while (out.length && out[0]!.role === 'assistant') out.shift()
    return out
  }

  private userContent(m: Message, vision: boolean): ChatContentPart[] {
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
        if (vision && VISION_MIME.has(a.mime)) content.push({ type: 'image', mime: a.mime, base64: this.d.files.readBase64(a.path) })
        else docs.push(`[image ${a.name} attached; this model cannot view images]`)
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

  /** After the first assistant reply: a short title from `default_models.helper`, else the first words. */
  private async maybeTitle(ctx: RunContext, reply: string): Promise<string | undefined> {
    if (this.d.library.conversationTitleSource(ctx.conversationId) !== 'none') return undefined
    const msgs = this.d.library.listMessages(ctx.conversationId)
    if (msgs.filter((m) => m.role === 'assistant' && m.status === 'complete').length !== 1) return undefined
    const firstUser = msgs.find((m) => m.role === 'user')
    const userText = firstUser ? textOf(firstUser.parts) : ''
    const fallback = firstWords(userText) || firstUser?.parts.find((p) => p.type === 'attachment')?.attachment.name || 'New chat'

    let title: string | undefined
    const helperId = this.d.config()?.default_models.helper
    const helper = helperId ? this.d.catalog.resolve(helperId) : null
    const provider = helper ? this.d.registry.get(helper.providerId) : null
    if (helper && provider) {
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
                  text: `Write a title of 2 to 6 words for this conversation. Reply with the title only, no quotes.\n\nUser: ${userText.slice(0, 2_000)}\n\nAssistant: ${reply.slice(0, 1_000)}`
                }
              ]
            }
          ],
          { model: helper.model, maxTokens: 40, pricing: helper.info?.pricing, signal }
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
