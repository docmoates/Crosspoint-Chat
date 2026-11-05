import { create } from 'zustand'
import { api, errorText } from '../lib/api'
import type { AppConfig } from '../lib/types'

interface ConfigState {
  config: AppConfig | null
  loading: boolean
  error: string | null
  init(): () => void
  load(): Promise<void>
}

export const useConfig = create<ConfigState>((set, get) => ({
  config: null,
  loading: false,
  error: null,

  init() {
    void get().load()
    return api.config.onChange((config) => set({ config }))
  },

  async load() {
    set({ loading: true, error: null })
    try {
      set({ config: await api.config.get(), loading: false })
    } catch (err) {
      set({ loading: false, error: errorText(err) })
    }
  },
}))
