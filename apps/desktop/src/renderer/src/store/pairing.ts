import { create } from 'zustand'
import { api, errorText } from '../lib/api'
import type { PairingStatus } from '../lib/types'

interface PairingState {
  status: PairingStatus | null
  loaded: boolean
  busy: boolean
  syncing: boolean
  error: string | null
  init(): () => void
  pair(code: string, host?: string): Promise<boolean>
  clearError(): void
  unpair(): Promise<void>
  syncNow(): Promise<void>
}

export const usePairing = create<PairingState>((set) => ({
  status: null,
  loaded: false,
  busy: false,
  syncing: false,
  error: null,

  init() {
    let alive = true
    api.pairing
      .status()
      .then((status) => alive && set({ status, loaded: true }))
      .catch((err) => alive && set({ loaded: true, error: errorText(err) }))
    const off = api.pairing.onStatus((status) => set({ status, loaded: true, syncing: false }))
    return () => {
      alive = false
      off()
    }
  },

  async pair(code, host) {
    set({ busy: true, error: null })
    try {
      const res = await api.pairing.pair(code, host)
      if (!res.ok) {
        set({ busy: false, error: res.error })
        return false
      }
      const status = await api.pairing.status()
      set({ busy: false, status })
      return true
    } catch (err) {
      set({ busy: false, error: errorText(err) })
      return false
    }
  },

  clearError: () => set({ error: null }),

  async unpair() {
    set({ busy: true })
    try {
      await api.pairing.unpair()
      set({ busy: false, status: await api.pairing.status() })
    } catch (err) {
      set({ busy: false, error: errorText(err) })
    }
  },

  async syncNow() {
    set({ syncing: true })
    try {
      await api.pairing.syncNow()
      set({ status: await api.pairing.status() })
    } catch (err) {
      set({ error: errorText(err) })
    } finally {
      set({ syncing: false })
    }
  },
}))
