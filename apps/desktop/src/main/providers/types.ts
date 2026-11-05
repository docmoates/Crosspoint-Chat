import type { ModelPricing, StreamEvent, ThinkingLevel } from '@shared/ipc'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A StreamEvent before the chat service stamps runId / conversationId / messageId on it. */
export type ProviderStreamEvent = DistributiveOmit<StreamEvent, 'runId' | 'conversationId' | 'messageId'>

export type ChatContentPart = { type: 'text'; text: string } | { type: 'image'; mime: string; base64: string }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: ChatContentPart[]
}

export interface StreamOptions {
  /** Provider-native model id (no `provider:` prefix). */
  model: string
  system?: string
  maxTokens?: number
  temperature?: number
  thinking?: ThinkingLevel
  /** From the catalog: whether to send reasoning parameters at all. */
  supportsReasoning?: boolean
  /** USD per 1M tokens, for computing cost when the provider does not report it. */
  pricing?: ModelPricing
  signal?: AbortSignal
}

/** Raw model record from a provider's model list, before tags/allowlist. */
export interface ChatProvider {
  readonly id: string
  readonly label: string
  stream(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderStreamEvent>
}

/** Thrown by adapters for HTTP failures so the fallback chain can decide whether to retry elsewhere. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly providerId: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }

  /** 429, 5xx or no response at all: worth trying the next provider. */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500
  }
}

export function toProviderError(err: unknown, providerId: string, label: string): ProviderError {
  if (err instanceof ProviderError) return err
  const e = err as { status?: unknown; message?: unknown; name?: unknown }
  const status = typeof e?.status === 'number' ? e.status : null
  const raw = typeof e?.message === 'string' ? e.message : String(err)
  const message = status ? `${label} returned HTTP ${status}: ${raw}` : `${label}: ${raw}`
  return new ProviderError(message, status, providerId)
}

export function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  return name === 'AbortError' || name === 'APIUserAbortError'
}
