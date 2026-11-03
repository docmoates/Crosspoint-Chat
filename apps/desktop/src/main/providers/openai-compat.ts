import OpenAI from 'openai'
import type { ProviderKind } from '@shared/admin-contract'
import type { ThinkingLevel } from '@shared/ipc'
import { OPENAI_CACHE, computeCost, perTokenToPerMillion, roundUsd } from './cost'
import {
  toProviderError,
  type CatalogModel,
  type ChatMessage,
  type ChatProvider,
  type ProviderStreamEvent,
  type StreamOptions
} from './types'

export interface OpenAICompatConfig {
  id: string
  kind: Extract<ProviderKind, 'openrouter' | 'openai-compatible'>
  label: string
  baseUrl: string
  apiKey: string
  appVersion?: string
  /** For tests. */
  client?: OpenAI
}

/** Minimal structural view of a Chat Completions stream chunk (OpenAI, OpenRouter and most compatible servers). */
export interface CompatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number } | null
    /** OpenRouter: actual charge in USD when `usage: { include: true }` is requested. */
    cost?: number
  } | null
}

type Finish = Extract<ProviderStreamEvent, { type: 'done' }>['finishReason']

/** Stateful mapping from compat chunks to provider events. Separate from I/O so it can be unit tested. */
export class CompatChunkMapper {
  private tools = new Map<number, { id: string; name: string; args: string }>()
  private finish: Finish = 'stop'
  private usage: { tokensIn: number; tokensOut: number; cachedTokens: number; cost?: number } | null = null

  constructor(
    private readonly providerId: string,
    private readonly model: string,
    private readonly pricing?: StreamOptions['pricing']
  ) {}

  map(chunk: CompatChunk): ProviderStreamEvent[] {
    const out: ProviderStreamEvent[] = []
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta
      const reasoning = d?.reasoning ?? d?.reasoning_content
      if (reasoning) out.push({ type: 'thinking', delta: reasoning })
      if (d?.content) out.push({ type: 'text', delta: d.content })
      for (const tc of d?.tool_calls ?? []) {
        const idx = tc.index ?? 0
        const cur = this.tools.get(idx) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        this.tools.set(idx, cur)
      }
      if (choice.finish_reason) this.finish = mapFinish(choice.finish_reason)
    }
    if (chunk.usage) {
      this.usage = {
        tokensIn: chunk.usage.prompt_tokens ?? 0,
        tokensOut: chunk.usage.completion_tokens ?? 0,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        ...(typeof chunk.usage.cost === 'number' ? { cost: chunk.usage.cost } : {})
      }
    }
    return out
  }

  end(): ProviderStreamEvent[] {
    const out: ProviderStreamEvent[] = []
    for (const [, t] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = t.args
      try {
        input = t.args ? JSON.parse(t.args) : {}
      } catch {
        // keep raw string when the model emitted invalid JSON
      }
      out.push({ type: 'tool_call', id: t.id || `call_${t.name}`, name: t.name, input })
    }
    if (this.usage) {
      const costUsd =
        this.usage.cost !== undefined ? roundUsd(this.usage.cost) : computeCost(this.pricing, this.usage, OPENAI_CACHE)
      out.push({
        type: 'usage',
        usage: {
          provider: this.providerId,
          model: this.model,
          tokensIn: this.usage.tokensIn,
          tokensOut: this.usage.tokensOut,
          cachedTokens: this.usage.cachedTokens,
          costUsd
        }
      })
    }
    out.push({ type: 'done', finishReason: this.finish })
    return out
  }
}

function mapFinish(reason: string): Finish {
  switch (reason) {
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'content_filter':
      return 'refusal'
    case 'error':
      return 'error'
    default:
      return 'stop'
  }
}

export function toCompatMessages(messages: ChatMessage[], system?: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content.map((p) => (p.type === 'text' ? p.text : '')).join('') })
      continue
    }
    const onlyText = m.content.every((p) => p.type === 'text')
    if (onlyText) {
      out.push({ role: 'user', content: m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n') })
    } else {
      out.push({
        role: 'user',
        content: m.content.map((p) =>
          p.type === 'text'
            ? ({ type: 'text', text: p.text } as const)
            : ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } } as const)
        )
      })
    }
  }
  return out
}

const EFFORT: Record<Exclude<ThinkingLevel, 'off'>, 'low' | 'medium' | 'high'> = { low: 'low', medium: 'medium', high: 'high' }

export class OpenAICompatProvider implements ChatProvider {
  readonly id: string
  readonly kind: OpenAICompatConfig['kind']
  readonly label: string
  private readonly client: OpenAI
  private readonly isOpenRouter: boolean
  private readonly isOpenAIDirect: boolean

  constructor(cfg: OpenAICompatConfig) {
    this.id = cfg.id
    this.kind = cfg.kind
    this.label = cfg.label
    this.isOpenRouter = cfg.kind === 'openrouter' || /openrouter\.ai/i.test(cfg.baseUrl)
    this.isOpenAIDirect = /^https:\/\/api\.openai\.com\//i.test(cfg.baseUrl)
    const defaultHeaders: Record<string, string> = {}
    if (this.isOpenRouter) {
      // OpenRouter app attribution.
      defaultHeaders['HTTP-Referer'] = 'https://admin.docmoates.com'
      defaultHeaders['X-Title'] = 'Crosspoint Chat'
    }
    this.client =
      cfg.client ??
      new OpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl.replace(/\/+$/, ''),
        defaultHeaders,
        maxRetries: 1,
        timeout: 10 * 60_000,
        dangerouslyAllowBrowser: false
      })
  }

  async *stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderStreamEvent> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: toCompatMessages(messages, options.system),
      stream: true,
      stream_options: { include_usage: true }
    }
    // api.openai.com wants max_completion_tokens (and rejects temperature on reasoning models).
    if (options.maxTokens) body[this.isOpenAIDirect ? 'max_completion_tokens' : 'max_tokens'] = options.maxTokens
    if (options.temperature !== undefined && !(this.isOpenAIDirect && options.supportsReasoning)) {
      body['temperature'] = options.temperature
    }
    if (this.isOpenRouter) body['usage'] = { include: true }
    const level = options.thinking
    if (options.supportsReasoning && level) {
      if (this.isOpenRouter) {
        body['reasoning'] = level === 'off' ? { enabled: false } : { effort: EFFORT[level] }
      } else if (level !== 'off') {
        body['reasoning_effort'] = EFFORT[level]
      }
    }

    const mapper = new CompatChunkMapper(this.id, options.model, options.pricing)
    let stream: AsyncIterable<CompatChunk>
    try {
      stream = (await this.client.chat.completions.create(
        body as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: options.signal }
      )) as unknown as AsyncIterable<CompatChunk>
    } catch (err) {
      throw toProviderError(err, this.id, this.label)
    }
    try {
      for await (const chunk of stream) {
        const errField = (chunk as { error?: { message?: string; code?: number } }).error
        if (errField) throw toProviderError({ status: errField.code, message: errField.message }, this.id, this.label)
        yield* mapper.map(chunk)
      }
    } catch (err) {
      if (options.signal?.aborted) return
      throw toProviderError(err, this.id, this.label)
    }
    yield* mapper.end()
  }

  async listModels(signal?: AbortSignal): Promise<CatalogModel[]> {
    try {
      const page = (await this.client.get('/models', { signal })) as { data?: RawCompatModel[] }
      return (page.data ?? []).map((m) => toCatalogModel(m, this.isOpenRouter)).filter((m): m is CatalogModel => m !== null)
    } catch (err) {
      throw toProviderError(err, this.id, this.label)
    }
  }
}

interface RawCompatModel {
  id?: string
  name?: string
  context_length?: number
  pricing?: { prompt?: string | number; completion?: string | number }
  architecture?: { input_modalities?: string[]; modality?: string }
  supported_parameters?: string[]
}

const NON_CHAT = /(embed|embedding|tts|whisper|dall-e|moderation|transcribe|realtime|audio|image|davinci|babbage|search)/i

export function toCatalogModel(m: RawCompatModel, isOpenRouter: boolean): CatalogModel | null {
  if (!m.id) return null
  if (!isOpenRouter && NON_CHAT.test(m.id)) return null
  const modalities = m.architecture?.input_modalities ?? (m.architecture?.modality ? m.architecture.modality.split('->')[0]?.split('+') : undefined)
  const params = m.supported_parameters ?? []
  return {
    id: m.id,
    name: m.name ?? m.id,
    context: typeof m.context_length === 'number' ? m.context_length : null,
    pricing: { in: perTokenToPerMillion(m.pricing?.prompt), out: perTokenToPerMillion(m.pricing?.completion) },
    capabilities: {
      vision: modalities ? modalities.includes('image') : /vision|gpt-4o|gpt-4\.1|gpt-5|o3|o4/i.test(m.id),
      tools: isOpenRouter ? params.includes('tools') : true,
      reasoning: isOpenRouter ? params.includes('reasoning') || params.includes('include_reasoning') : /^(o\d|gpt-5)/i.test(m.id)
    }
  }
}
