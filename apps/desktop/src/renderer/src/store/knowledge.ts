import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'
import type { KnowledgeCard } from '../lib/types'
import { useApp } from './app'

const MAX_QUESTION = 300
/** The plain card shows first; the tidied one replaces it when the server has it. */
const MAX_ASKS = 4
const ASK_AGAIN_MS = 4_000

type Entry = { state: 'loading' } | { state: 'done'; card: KnowledgeCard | null }

interface KnowledgeState {
  entries: Record<string, Entry>
  load(entity: string): void
}

/** One lookup per question per session. The server finds the name and caches the card. */
export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  entries: {},
  load(entity) {
    if (get().entries[entity]) return
    set((s) => ({ entries: { ...s.entries, [entity]: { state: 'loading' } } }))
    const done = (card: KnowledgeCard | null): void => set((s) => ({ entries: { ...s.entries, [entity]: { state: 'done', card } } }))
    const ask = (tries: number): void => {
      api.knowledge.lookup(entity).then(
        (card) => {
          // Keep what is showing if a later ask fails.
          if (card) done(card)
          else if (tries === MAX_ASKS) done(null)
          if (card?.cleaning && tries > 1) setTimeout(() => ask(tries - 1), ASK_AGAIN_MS)
        },
        () => {
          if (tries === MAX_ASKS) done(null)
        }
      )
    }
    ask(MAX_ASKS)
  },
}))

/** The knowledge card for what a question is about, or null (setting off, not an entity question, no match, still loading). */
export function useKnowledgeCard(question: string | undefined): KnowledgeCard | null {
  const enabled = useApp((s) => s.settings.knowledgeCards)
  // Long messages are not questions about a name, so they are not sent for a card.
  const entity = enabled && question && question.length <= MAX_QUESTION ? question.trim() : null
  const entry = useKnowledgeStore((s) => (entity ? s.entries[entity] : undefined))
  useEffect(() => {
    if (entity) useKnowledgeStore.getState().load(entity)
  }, [entity])
  return entry?.state === 'done' ? entry.card : null
}
