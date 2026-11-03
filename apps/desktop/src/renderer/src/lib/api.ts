import type { CrosspointApi } from './types'

/**
 * Thin wrapper around window.crosspoint, the only data source. Throws a readable error when the
 * preload bridge is missing (renderer opened outside Electron) instead of failing deep inside a
 * component.
 */
function bridge(): CrosspointApi {
  const bridged = (window as Window & { crosspoint?: CrosspointApi }).crosspoint
  if (!bridged) throw new Error('Crosspoint bridge is not available. Start the app from Electron.')
  return bridged
}

export const api: CrosspointApi = new Proxy({} as CrosspointApi, {
  get(_target, area: string | symbol) {
    return bridge()[area as keyof CrosspointApi]
  },
})

export function hasBridge(): boolean {
  return typeof (window as Window & { crosspoint?: unknown }).crosspoint === 'object'
}

/** Strips Electron's "Error invoking remote method" prefix so users see the real message. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  if (typeof err === 'string') return err
  return 'Something went wrong.'
}
