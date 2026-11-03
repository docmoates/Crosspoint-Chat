import { create } from 'zustand'
import { api, errorText } from '../lib/api'
import type { AppConfig, ModelInfo, Tag } from '../lib/types'

interface ConfigState {
  config: AppConfig | null
  models: ModelInfo[]
  tags: Tag[]
  loading: boolean
  refreshing: boolean
  error: string | null
  init(): () => void
  load(): Promise<void>
  refreshModels(): Promise<void>
  setModelTags(modelId: string, tags: string[]): Promise<void>
  saveTag(t: Tag): Promise<void>
  removeTag(id: string): Promise<void>
}

export const useConfig = create<ConfigState>((set, get) => ({
  config: null,
  models: [],
  tags: [],
  loading: false,
  refreshing: false,
  error: null,

  init() {
    void get().load()
    return api.config.onChange((config) => {
      set({ config })
      // allowed_models may have changed; the catalog is filtered by it in main.
      api.models
        .list()
        .then((models) => set({ models }))
        .catch(() => undefined)
    })
  },

  async load() {
    set({ loading: true, error: null })
    try {
      const [config, models, tags] = await Promise.all([api.config.get(), api.models.list(), api.models.tags.list()])
      set({ config, models, tags, loading: false })
    } catch (err) {
      set({ loading: false, error: errorText(err) })
    }
  },

  async refreshModels() {
    set({ refreshing: true, error: null })
    try {
      await api.models.refresh()
      set({ models: await api.models.list() })
    } catch (err) {
      set({ error: errorText(err) })
    } finally {
      set({ refreshing: false })
    }
  },

  async setModelTags(modelId, tags) {
    const prev = get().models
    set({ models: prev.map((m) => (m.id === modelId ? { ...m, tags } : m)) })
    try {
      await api.models.setTags(modelId, tags)
    } catch (err) {
      set({ models: prev, error: errorText(err) })
    }
  },

  async saveTag(t) {
    try {
      await api.models.tags.save(t)
      set({ tags: await api.models.tags.list() })
    } catch (err) {
      set({ error: errorText(err) })
    }
  },

  async removeTag(id) {
    try {
      await api.models.tags.remove(id)
      const [tags, models] = await Promise.all([api.models.tags.list(), api.models.list()])
      set({ tags, models })
    } catch (err) {
      set({ error: errorText(err) })
    }
  },
}))

/** Tags on models may be stored by tag id or by tag name; resolve both. */
export function resolveTag(tags: Tag[], ref: string): Tag | undefined {
  return tags.find((t) => t.id === ref) ?? tags.find((t) => t.name.toLowerCase() === ref.toLowerCase())
}

export function providerLabel(config: AppConfig | null, providerId: string): string {
  const p = config?.providers.find((x) => x.id === providerId || x.kind === providerId)
  if (p) return p.label
  if (providerId === 'openrouter') return 'OpenRouter'
  if (providerId === 'anthropic') return 'Anthropic direct'
  return providerId
}

export function defaultChatModel(config: AppConfig | null): string | undefined {
  return config?.default_models.chat ?? undefined
}
