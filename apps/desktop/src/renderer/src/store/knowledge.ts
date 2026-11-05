import { useEffect } from 'react'
import { create } from 'zustand'
import { extractEntityQuery } from '@shared/entity-query'
import { api } from '../lib/api'
import type { KnowledgeCard } from '../lib/types'
import { useApp } from './app'

type Entry = { state: 'loading' } | { state: 'done'; card: KnowledgeCard | null }

interface KnowledgeState {
  entries: Record<string, Entry>
  load(entity: string): void
}

/** One lookup per entity name per session; main also caches on disk, so reopening an old chat is instant. */
export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  entries: {},
  load(entity) {
    if (get().entries[entity]) return
    set((s) => ({ entries: { ...s.entries, [entity]: { state: 'loading' } } }))
    const done = (card: KnowledgeCard | null): void => set((s) => ({ entries: { ...s.entries, [entity]: { state: 'done', card } } }))
    api.knowledge.lookup(entity).then(done, () => done(null))
  },
}))

/** The knowledge card for what a question is about, or null (setting off, not an entity question, no match, still loading). */
export function useKnowledgeCard(question: string | undefined): KnowledgeCard | null {
  const enabled = useApp((s) => s.settings.knowledgeCards)
  const entity = enabled && question ? extractEntityQuery(question) : null
  const entry = useKnowledgeStore((s) => (entity ? s.entries[entity] : undefined))
  useEffect(() => {
    if (entity) useKnowledgeStore.getState().load(entity)
  }, [entity])
  return entry?.state === 'done' ? entry.card : null
}
