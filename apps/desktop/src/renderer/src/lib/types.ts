// Single import point for contract types: packages/shared/ipc.ts (zod-inferred, shared with main
// and preload). Components import from here so the source can move without touching them.
export type * from '@shared/ipc'

/** Thinking levels accepted by ChatSettings.thinking. */
export type ThinkingLevelValue = 'off' | 'low' | 'medium' | 'high'
