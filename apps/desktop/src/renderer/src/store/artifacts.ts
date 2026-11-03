import { create } from 'zustand'
import { api, errorText } from '../lib/api'
import type { Artifact } from '../lib/types'
import { useApp } from './app'

interface ArtifactsState {
  conversationId: string | null
  list: Artifact[]
  loading: boolean
  error: string | null
  selectedId: string | null
  load(conversationId: string | null): Promise<void>
  select(id: string | null): void
  openArtifact(id: string): void
}

export const useArtifacts = create<ArtifactsState>((set, get) => ({
  conversationId: null,
  list: [],
  loading: false,
  error: null,
  selectedId: null,

  async load(conversationId) {
    if (!conversationId) {
      set({ conversationId: null, list: [], selectedId: null, error: null })
      return
    }
    const switching = get().conversationId !== conversationId
    set({ conversationId, loading: true, error: null, ...(switching ? { list: [], selectedId: null } : {}) })
    try {
      const list = await api.artifacts.list(conversationId)
      if (get().conversationId !== conversationId) return
      set({ list, loading: false })
    } catch (err) {
      if (get().conversationId === conversationId) set({ loading: false, error: errorText(err) })
    }
  },

  select: (selectedId) => set({ selectedId }),

  openArtifact(id) {
    set({ selectedId: id })
    useApp.getState().setArtifactPane(true)
  },
}))
