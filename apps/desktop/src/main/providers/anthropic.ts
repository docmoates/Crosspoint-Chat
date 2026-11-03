import Anthropic from '@anthropic-ai/sdk'
import type { ModelPricing, ThinkingLevel } from '@shared/ipc'
import { ANTHROPIC_CACHE, computeCost } from './cost'
import {
  toProviderError,
  type CatalogModel,
  type ChatMessage,
  type ChatProvider,
  type ProviderStreamEvent,
  type StreamOptions
} from './types'

/**
 * Anthropic first-party models with list prices (USD per 1M tokens, cached 2026-10-06).
 * The live `/v1/models` list is preferred when the key works; this table fills prices and
 * stands in when the models endpoint is unreachable.
 */
export const ANTHROPIC_MODELS: ReadonlyArray<{ id: string; name: string; context: number; in: number; out: number }> = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', context: 1_000_000, in: 10, out: 50 },
  { id: 'claude-fable-5', name: 'Claude Fable 5', context: 1_000_000, in: 10, out: 50 },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', context: 1_000_000, in: 4, out: 20 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', context: 1_000_000, in: 5, out: 25 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', context: 1_000_000, in: 5, out: 25 },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', context: 1_000_000, in: 5, out: 25 },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context: 1_000_000, in: 5, out: 25 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 1_000_000, in: 2, out: 10 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context: 1_000_000, in: 2, out: 10 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context: 1_000_000, in: 3, out: 15 },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', context: 1_000_000, in: 0.1, out: 0.5 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', context: 200_000, in: 1, out: 5 }
]

export function anthropicStaticPricing(id: string): ModelPricing | null {
  const m = ANTHROPIC_MODELS.find((x) => id === x.id || id.startsWith(`${x.id}-2`))
  return m ? { in: m.in, out: m.out } : null
}

interface ModelGen {
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos' | 'other'
  version: number
}

export function parseClaudeModel(id: string): ModelGen {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id)
  if (m) return { family: m[1] as ModelGen['family'], version: Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0) }
  const legacy = /^claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)/.exec(id) // claude-3-7-sonnet-...
  if (legacy) return { family: legacy[3] as ModelGen['family'], version: Number(legacy[1]) + (legacy[2] ? Number(legacy[2]) / 10 : 0) }
  return { family: 'other', version: 0 }
}

const BUDGET: Record<Exclude<ThinkingLevel, 'off'>, number> = { low: 2_048, medium: 8_192, high: 24_576 }

/**
 * Thinking parameters per model generation:
 * - Fable/Mythos, and Opus/Sonnet/Haiku 5.5+: thinking is always on; "off" maps to low effort.
 * - Opus/Sonnet 4.6+ and other 5.x: adaptive thinking + effort; "off" omits thinking.
 * - Older (Haiku 4.5, Sonnet 4.5, 3.7): `budget_tokens`.
 */
export function anthropicThinkingParams(
  model: string,
  level: ThinkingLevel | undefined,
  maxTokens: number
): { thinking?: Record<string, unknown>; output_config?: Record<string, unknown>; max_tokens: number } {
  const gen = parseClaudeModel(model)
  if (!level) return { max_tokens: maxTokens }
  const alwaysOn = gen.family === 'fable' || gen.family === 'mythos' || gen.version >= 5.5
  const adaptive = alwaysOn || gen.version >= 4.6 || (gen.family === 'haiku' && gen.version >= 5)
  if (adaptive) {
    if (level === 'off') {
      return gen.version >= 5 || alwaysOn ? { output_config: { effort: 'low' }, max_tokens: maxTokens } : { max_tokens: maxTokens }
    }
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: level },
      max_tokens: maxTokens
    }
  }
  const supportsBudget = gen.version >= 3.7 && gen.family !== 'other'
  if (level === 'off' || !supportsBudget) return { max_tokens: maxTokens }
  const budget = BUDGET[level]
  return { thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: Math.max(maxTokens, budget + 4_096) }
}

/** Minimal structural view of the raw SSE events from `messages.create({ stream: true })`. */
export type AnthropicRawEvent =
  | { type: 'message_start'; message: { usage?: AnthropicUsage } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; id?: string; name?: string; text?: string; thinking?: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: string; text?: string; thinking?: string; partial_json?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string | null }; usage?: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'error'; error?: { type?: string; message?: string } }
  | { type: 'ping' }

interface AnthropicUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

type Finish = Extract<ProviderStreamEvent, { type: 'done' }>['finishReason']

export class AnthropicEventMapper {
  private tools = new Map<number, { id: string; name: string; json: string }>()
  private input = 0
  private cacheRead = 0
  private cacheWrite = 0
  private output = 0
  private finish: Finish = 'stop'
  private finished = false

  constructor(
    private readonly providerId: string,
    private readonly model: string,
    private readonly pricing?: ModelPricing
  ) {}

  map(ev: AnthropicRawEvent): ProviderStreamEvent[] {
    switch (ev.type) {
      case 'message_start':
        this.applyUsage(ev.message.usage)
        return []
      case 'content_block_start': {
        const b = ev.content_block
        if (b.type === 'tool_use') this.tools.set(ev.index, { id: b.id ?? `tool_${ev.index}`, name: b.name ?? '', json: '' })
        if (b.type === 'text' && b.text) return [{ type: 'text', delta: b.text }]
        if (b.type === 'thinking' && b.thinking) return [{ type: 'thinking', delta: b.thinking }]
        return []
      }
      case 'content_block_delta': {
        const d = ev.delta
        if (d.type === 'text_delta' && d.text) return [{ type: 'text', delta: d.text }]
        if (d.type === 'thinking_delta' && d.thinking) return [{ type: 'thinking', delta: d.thinking }]
        if (d.type === 'input_json_delta' && d.partial_json) {
          const t = this.tools.get(ev.index)
          if (t) t.json += d.partial_json
        }
        return []
      }
      case 'content_block_stop': {
        const t = this.tools.get(ev.index)
        if (!t) return []
        this.tools.delete(ev.index)
        let input: unknown = t.json
        try {
          input = t.json ? JSON.parse(t.json) : {}
        } catch {
          // keep raw text
        }
        return [{ type: 'tool_call', id: t.id, name: t.name, input }]
      }
      case 'message_delta':
        this.applyUsage(ev.usage)
        if (ev.delta.stop_reason) this.finish = mapStop(ev.delta.stop_reason)
        return []
      case 'message_stop':
        return this.end()
      case 'error':
        return [{ type: 'error', code: ev.error?.type, message: ev.error?.message ?? 'Anthropic stream error' }]
      default:
        return []
    }
  }

  /** Emits usage + done once (also safe to call when the stream ended without message_stop). */
  end(): ProviderStreamEvent[] {
    if (this.finished) return []
    this.finished = true
    const tokensIn = this.input + this.cacheRead + this.cacheWrite
    const costUsd = computeCost(
      this.pricing,
      { tokensIn, tokensOut: this.output, cachedTokens: this.cacheRead, cacheWriteTokens: this.cacheWrite },
      ANTHROPIC_CACHE
    )
    return [
      {
        type: 'usage',
        usage: { provider: this.providerId, model: this.model, tokensIn, tokensOut: this.output, cachedTokens: this.cacheRead, costUsd }
      },
      { type: 'done', finishReason: this.finish }
    ]
  }

  private applyUsage(u: AnthropicUsage | undefined): void {
    if (!u) return
    if (u.input_tokens != null) this.input = u.input_tokens
    if (u.cache_read_input_tokens != null) this.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) this.cacheWrite = u.cache_creation_input_tokens
    if (u.output_tokens != null) this.output = u.output_tokens
  }
}

function mapStop(reason: string): Finish {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'refusal'
    default:
      return 'stop'
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const m of messages) {
    const content: Anthropic.ContentBlockParam[] = m.content.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text || ' ' }
        : {
            type: 'image',
            source: { type: 'base64', media_type: p.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: p.base64 }
          }
    )
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role && Array.isArray(prev.content)) prev.content.push(...content)
    else out.push({ role: m.role, content })
  }
  return out
}

/** Claude 3.x caps output at 8K; 4.x and later stream 32K comfortably. */
export function defaultMaxTokens(model: string): number {
  const v = parseClaudeModel(model).version
  return v > 0 && v < 4 ? 8_192 : 32_000
}

/** Below roughly this many prompt characters a cache write costs more than it can save. */
const CACHE_MIN_CHARS = 8_000

export interface AnthropicConfig {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  client?: Anthropic
}

export class AnthropicProvider implements ChatProvider {
  readonly id: string
  readonly kind = 'anthropic' as const
  readonly label: string
  private readonly client: Anthropic

  constructor(cfg: AnthropicConfig) {
    this.id = cfg.id
    this.label = cfg.label
    this.client =
      cfg.client ??
      new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''), maxRetries: 1, timeout: 10 * 60_000 })
  }

  async *stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderStreamEvent> {
    const params: Record<string, unknown> = {
      model: options.model,
      messages: toAnthropicMessages(messages),
      stream: true,
      ...anthropicThinkingParams(options.model, options.thinking, options.maxTokens ?? defaultMaxTokens(options.model))
    }
    if (options.system) params['system'] = options.system
    // Sampling parameters are rejected by current Claude models, so temperature is not forwarded.
    const promptChars = (options.system?.length ?? 0) + messages.reduce((n, m) => n + m.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 6_000), 0), 0)
    if (promptChars >= CACHE_MIN_CHARS) params['cache_control'] = { type: 'ephemeral' }

    const pricing = options.pricing ?? anthropicStaticPricing(options.model) ?? undefined
    const mapper = new AnthropicEventMapper(this.id, options.model, pricing)
    let stream: AsyncIterable<AnthropicRawEvent>
    try {
      stream = (await this.client.messages.create(params as unknown as Anthropic.MessageCreateParamsStreaming, {
        signal: options.signal
      })) as unknown as AsyncIterable<AnthropicRawEvent>
    } catch (err) {
      throw toProviderError(err, this.id, this.label)
    }
    try {
      for await (const ev of stream) {
        if (ev.type === 'error') throw toProviderError({ status: ev.error?.type === 'overloaded_error' ? 529 : null, message: ev.error?.message }, this.id, this.label)
        yield* mapper.map(ev)
      }
    } catch (err) {
      if (options.signal?.aborted) return
      throw toProviderError(err, this.id, this.label)
    }
    yield* mapper.end()
  }

  async listModels(signal?: AbortSignal): Promise<CatalogModel[]> {
    try {
      const out: CatalogModel[] = []
      for await (const m of this.client.models.list({ limit: 100 }, { signal })) {
        const info = m as unknown as { id: string; display_name?: string; max_input_tokens?: number | null; capabilities?: Record<string, unknown> | null }
        const staticRow = ANTHROPIC_MODELS.find((x) => x.id === info.id)
        const price = anthropicStaticPricing(info.id)
        out.push({
          id: info.id,
          name: info.display_name ?? staticRow?.name ?? info.id,
          context: info.max_input_tokens ?? staticRow?.context ?? null,
          pricing: price ?? { in: null, out: null },
          capabilities: { vision: true, tools: true, reasoning: parseClaudeModel(info.id).version >= 3.7 }
        })
      }
      return out
    } catch (err) {
      throw toProviderError(err, this.id, this.label)
    }
  }
}

/** Fallback catalog when `/v1/models` cannot be reached. */
export function staticAnthropicCatalog(): CatalogModel[] {
  return ANTHROPIC_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context,
    pricing: { in: m.in, out: m.out },
    capabilities: { vision: true, tools: true, reasoning: true }
  }))
}
