import type { AdminConfig, ProviderKind } from '@shared/admin-contract'
import type { ModelInfo, ModelPricing, Tag } from '@shared/ipc'
import { nowIso, parseJson, type DB } from '../db'
import { anthropicStaticPricing, staticAnthropicCatalog } from '../providers/anthropic'
import { usable, type ProviderRegistry } from '../providers/registry'
import type { CatalogModel } from '../providers/types'

const HOUR = 60 * 60 * 1000

export interface ResolvedModel {
  modelId: string
  providerId: string
  kind: ProviderKind
  /** Id the provider API expects. */
  model: string
  info: ModelInfo | null
}

/**
 * Merged catalog: OpenRouter /models (cached hourly in SQLite) + Anthropic (live list or the static table)
 * + each OpenAI-compatible endpoint's /models when reachable; filtered by admin `allowed_models`.
 */
export class ModelCatalog {
  private refreshing: Promise<void> | null = null

  constructor(
    private readonly db: DB,
    private readonly registry: ProviderRegistry,
    private readonly config: () => AdminConfig | null
  ) {}

  /** Refresh stale (>1 h) provider lists; `force` refreshes all. Failures keep the previous cache. */
  refresh(force = false): Promise<void> {
    if (!this.refreshing) this.refreshing = this.doRefresh(force).finally(() => (this.refreshing = null))
    return this.refreshing
  }

  async list(): Promise<ModelInfo[]> {
    const cfg = this.config()
    if (!cfg) return []
    if (this.needsRefresh()) await this.refresh().catch(() => undefined)
    return this.merged(cfg)
  }

  /** Synchronous view from cache only (no network). */
  cachedList(): ModelInfo[] {
    const cfg = this.config()
    return cfg ? this.merged(cfg) : []
  }

  resolve(modelId: string): ResolvedModel | null {
    const cfg = this.config()
    if (!cfg) return null
    const info = this.cachedList().find((m) => m.id === modelId) ?? null
    const providers = cfg.providers.filter(usable)
    if (info) {
      const p = providers.find((x) => x.id === info.provider)
      if (!p) return null
      return { modelId, providerId: p.id, kind: p.kind, model: rawModelId(modelId, p.id, p.kind), info }
    }
    // Not in the cached catalog (offline or not fetched yet): infer from the id shape.
    if (!isAllowed(modelId, cfg.allowed_models)) return null
    const colon = providers.find((p) => p.kind === 'openai-compatible' && modelId.startsWith(`${p.id}:`))
    if (colon) return { modelId, providerId: colon.id, kind: colon.kind, model: modelId.slice(colon.id.length + 1), info: null }
    if (modelId.startsWith('claude-')) {
      const a = providers.find((p) => p.kind === 'anthropic')
      if (a) return { modelId, providerId: a.id, kind: 'anthropic', model: modelId, info: null }
    }
    if (modelId.includes('/')) {
      const o = providers.find((p) => p.kind === 'openrouter')
      if (o) return { modelId, providerId: o.id, kind: 'openrouter', model: modelId, info: null }
    }
    return null
  }

  /**
   * Fallback candidates for a failed model, in chain order OpenRouter -> Anthropic -> custom endpoints,
   * skipping the provider that failed. Only models that are the same underlying model are offered.
   */
  fallbacks(primary: ResolvedModel): ResolvedModel[] {
    const cfg = this.config()
    if (!cfg) return []
    const order: ProviderKind[] = ['openrouter', 'anthropic', 'openai-compatible']
    const providers = cfg.providers
      .filter((p) => usable(p) && p.id !== primary.providerId)
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    const key = equivalenceKey(primary.modelId, primary.kind, primary.providerId)
    const models = this.cachedList()
    const out: ResolvedModel[] = []
    for (const p of providers) {
      const match = models.find((m) => m.provider === p.id && equivalenceKey(m.id, p.kind, p.id) === key)
      if (match) out.push({ modelId: match.id, providerId: p.id, kind: p.kind, model: rawModelId(match.id, p.id, p.kind), info: match })
    }
    return out
  }

  setTags(modelId: string, tagIds: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId)
      const ins = this.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) SELECT ?, id FROM tags WHERE id = ?')
      for (const t of new Set(tagIds)) ins.run(modelId, t)
    })()
  }

  listTags(): Tag[] {
    return this.db.prepare('SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE').all() as Tag[]
  }

  saveTag(t: Tag): void {
    this.db
      .prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color')
      .run(t.id, t.name, t.color)
  }

  removeTag(id: string): void {
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id)
  }

  clearCache(): void {
    this.db.prepare('DELETE FROM models_cache').run()
  }

  private needsRefresh(): boolean {
    const providers = this.registry.all()
    if (providers.length === 0) return false
    const rows = this.db.prepare('SELECT provider, fetched_at FROM models_cache').all() as { provider: string; fetched_at: string }[]
    const fetched = new Map(rows.map((r) => [r.provider, Date.parse(r.fetched_at)]))
    return providers.some((p) => !fetched.has(p.id) || Date.now() - (fetched.get(p.id) ?? 0) > HOUR)
  }

  private async doRefresh(force: boolean): Promise<void> {
    const rows = this.db.prepare('SELECT provider, fetched_at FROM models_cache').all() as { provider: string; fetched_at: string }[]
    const fetched = new Map(rows.map((r) => [r.provider, Date.parse(r.fetched_at)]))
    const upsert = this.db.prepare(
      'INSERT INTO models_cache (provider, fetched_at, payload) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload'
    )
    await Promise.all(
      this.registry.all().map(async (p) => {
        if (!force && fetched.has(p.id) && Date.now() - (fetched.get(p.id) ?? 0) < HOUR) return
        try {
          const models = await p.listModels(AbortSignal.timeout(20_000))
          upsert.run(p.id, nowIso(), JSON.stringify(models))
        } catch {
          if (p.kind === 'anthropic' && !fetched.has(p.id)) {
            // Keep the picker usable with the known first-party list; retry on the next refresh.
            upsert.run(p.id, new Date(Date.now() - HOUR + 5 * 60_000).toISOString(), JSON.stringify(staticAnthropicCatalog()))
          }
        }
      })
    )
  }

  private merged(cfg: AdminConfig): ModelInfo[] {
    const rows = this.db.prepare('SELECT provider, payload FROM models_cache').all() as { provider: string; payload: string }[]
    const byProvider = new Map(rows.map((r) => [r.provider, parseJson<CatalogModel[]>(r.payload, [])]))
    const tagRows = this.db.prepare('SELECT model_id, tag_id FROM model_tags').all() as { model_id: string; tag_id: string }[]
    const tags = new Map<string, string[]>()
    for (const r of tagRows) tags.set(r.model_id, [...(tags.get(r.model_id) ?? []), r.tag_id])

    const openrouter = cfg.providers.find((p) => p.kind === 'openrouter')
    const orModels = openrouter ? (byProvider.get(openrouter.id) ?? []) : []
    const orPricing = new Map(orModels.map((m) => [m.id, m.pricing]))

    const out: ModelInfo[] = []
    for (const p of cfg.providers) {
      if (!usable(p)) continue
      for (const m of byProvider.get(p.id) ?? []) {
        const id = p.kind === 'openai-compatible' ? `${p.id}:${m.id}` : m.id
        if (!isAllowed(id, cfg.allowed_models, m.id)) continue
        out.push({
          id,
          provider: p.id,
          name: m.name,
          context: m.context,
          pricing: fillPricing(m, p.kind, p.id, orPricing),
          capabilities: m.capabilities,
          tags: tags.get(id) ?? []
        })
      }
    }
    return out
  }
}

function fillPricing(m: CatalogModel, kind: ProviderKind, providerId: string, orPricing: Map<string, ModelPricing>): ModelPricing {
  if (m.pricing.in != null || m.pricing.out != null) return m.pricing
  if (kind === 'anthropic') {
    return anthropicStaticPricing(m.id) ?? orPricing.get(`anthropic/${anthropicToOpenRouter(m.id)}`) ?? m.pricing
  }
  if (kind === 'openai-compatible' && providerId === 'openai') return orPricing.get(`openai/${m.id}`) ?? m.pricing
  return m.pricing
}

/** claude-sonnet-4-5 -> claude-sonnet-4.5 (OpenRouter naming). */
export function anthropicToOpenRouter(id: string): string {
  return id.replace(/-(\d+)-(\d{1,2})$/, '-$1.$2').replace(/-\d{8}$/, '')
}

export function rawModelId(modelId: string, providerId: string, kind: ProviderKind): string {
  return kind === 'openai-compatible' && modelId.startsWith(`${providerId}:`) ? modelId.slice(providerId.length + 1) : modelId
}

/** Key that is equal for the same underlying model across providers. */
export function equivalenceKey(modelId: string, kind: ProviderKind, providerId: string): string {
  const raw = rawModelId(modelId, providerId, kind)
  const base = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw
  return base.toLowerCase().replace(/-\d{8}$/, '').replace(/\./g, '-')
}

/** Empty allowlist = everything. Entries match the full id, the provider-native id, or a `prefix*` pattern. */
export function isAllowed(id: string, allowed: string[], rawId?: string): boolean {
  if (allowed.length === 0) return true
  return allowed.some((a) => {
    const entry = a.trim()
    if (!entry) return false
    if (entry.endsWith('*')) {
      const prefix = entry.slice(0, -1)
      return id.startsWith(prefix) || (rawId?.startsWith(prefix) ?? false)
    }
    return entry === id || entry === rawId
  })
}
