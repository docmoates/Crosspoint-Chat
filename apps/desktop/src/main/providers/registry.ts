import { createHash } from 'node:crypto'
import type { AdminProvider } from '@shared/admin-contract'
import { AnthropicProvider } from './anthropic'
import { OpenAICompatProvider } from './openai-compat'
import type { ChatProvider } from './types'

/** Builds provider clients from the admin config, keyed by id + key fingerprint so key rotation rebuilds them. */
export class ProviderRegistry {
  private cache = new Map<string, { fp: string; provider: ChatProvider }>()

  constructor(
    private readonly source: () => AdminProvider[],
    private readonly appVersion: string
  ) {}

  /** Enabled providers that have a key, in admin order. */
  all(): ChatProvider[] {
    return this.source()
      .filter((p) => p.enabled && p.api_key)
      .map((p) => this.build(p))
  }

  get(id: string): ChatProvider | null {
    const p = this.source().find((x) => x.id === id)
    if (!p || !p.enabled || !p.api_key) return null
    return this.build(p)
  }

  clear(): void {
    this.cache.clear()
  }

  private build(p: AdminProvider): ChatProvider {
    const fp = createHash('sha256').update(`${p.kind}|${p.base_url}|${p.api_key}`).digest('hex')
    const hit = this.cache.get(p.id)
    if (hit && hit.fp === fp) return hit.provider
    const provider: ChatProvider =
      p.kind === 'anthropic'
        ? new AnthropicProvider({ id: p.id, label: p.label, baseUrl: p.base_url, apiKey: p.api_key! })
        : new OpenAICompatProvider({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.base_url, apiKey: p.api_key!, appVersion: this.appVersion })
    this.cache.set(p.id, { fp, provider })
    return provider
  }
}
