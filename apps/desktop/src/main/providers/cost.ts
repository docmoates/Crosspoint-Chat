import type { ModelPricing } from '@shared/ipc'

export interface TokenUsage {
  /** All prompt tokens, cached ones included. */
  tokensIn: number
  tokensOut: number
  /** Prompt tokens served from cache (subset of tokensIn). */
  cachedTokens: number
  /** Prompt tokens written to cache (subset of tokensIn; Anthropic bills these at a premium). */
  cacheWriteTokens?: number
}

export interface CacheMultipliers {
  read: number
  write: number
}

/** Anthropic: cache reads 0.1x, 5-minute cache writes 1.25x. */
export const ANTHROPIC_CACHE: CacheMultipliers = { read: 0.1, write: 1.25 }
/** OpenAI-compatible: discounts vary (0.1x-0.5x); 0.5x keeps local limits conservative. */
export const OPENAI_CACHE: CacheMultipliers = { read: 0.5, write: 1 }

/** USD for one call. Pricing is USD per 1M tokens; unknown prices count as 0. */
export function computeCost(pricing: ModelPricing | undefined, usage: TokenUsage, cache: CacheMultipliers = OPENAI_CACHE): number {
  if (!pricing) return 0
  const pin = pricing.in ?? 0
  const pout = pricing.out ?? 0
  const cached = Math.min(Math.max(usage.cachedTokens, 0), usage.tokensIn)
  const written = Math.min(Math.max(usage.cacheWriteTokens ?? 0, 0), usage.tokensIn - cached)
  const fresh = Math.max(usage.tokensIn - cached - written, 0)
  const usd = (fresh * pin + cached * pin * cache.read + written * pin * cache.write + usage.tokensOut * pout) / 1_000_000
  return roundUsd(usd)
}

export function roundUsd(v: number): number {
  return Math.round(v * 1e8) / 1e8
}

/** Rough token count for estimates (about 4 characters per token for English text and code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Fixed cost per image part for estimates only; real usage comes back from the provider. */
export const IMAGE_TOKEN_ESTIMATE = 1_600

export function estimateCost(pricing: ModelPricing | undefined, promptTokens: number, expectedOutputTokens: number): number {
  return computeCost(pricing, { tokensIn: promptTokens, tokensOut: expectedOutputTokens, cachedTokens: 0 })
}

/** OpenRouter publishes per-token prices as strings ("0.000003"); convert to USD per 1M tokens. */
export function perTokenToPerMillion(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1_000_000 * 1e6) / 1e6
}
