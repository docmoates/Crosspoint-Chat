import { create } from 'zustand'
import { api, errorText } from '../lib/api'
import { uid } from '../lib/utils'
import type { LocalSettings, UsageSummary } from '../lib/types'

export type View = 'chat' | 'projects' | 'artifacts' | 'settings' | 'code'

export type SettingsTab =
  | 'general'
  | 'health'
  | 'device'
  | 'providers'
  | 'models'
  | 'memory'
  | 'usage'
  | 'data'
  | 'about'

export interface Toast {
  id: string
  text: string
  kind: 'info' | 'error'
}

const DEFAULT_SETTINGS: LocalSettings = {
  theme: 'system',
  font: 'system',
  fontSize: 14,
  sendOnEnter: true,
  replyDetails: 'full',
  defaultModelOverride: null,
  dailyCapUsd: null,
  dataFolder: '',
}

export const FONT_STACKS: Record<string, string> = {
  system: "'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif",
  segoe: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  serif: "Charter, 'Iowan Old Style', Georgia, Cambria, serif",
  mono: "'Cascadia Code', 'Geist Mono', ui-monospace, Consolas, monospace",
}

interface AppState {
  view: View
  settingsTab: SettingsTab
  paletteOpen: boolean
  sidebarCollapsed: boolean
  sidebarMobileOpen: boolean
  artifactPaneOpen: boolean
  selectedProjectId: string | null
  settings: LocalSettings
  settingsLoaded: boolean
  usage: UsageSummary | null
  version: string
  toasts: Toast[]

  go(view: View): void
  openSettings(tab?: SettingsTab): void
  openProject(id: string | null): void
  setPalette(open: boolean): void
  toggleSidebar(): void
  setSidebarMobile(open: boolean): void
  setArtifactPane(open: boolean): void
  loadSettings(): Promise<void>
  setSettings(patch: Partial<LocalSettings>): Promise<void>
  refreshUsage(): Promise<void>
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: string): void
}

export function applyTheme(s: Pick<LocalSettings, 'theme' | 'font' | 'fontSize'>): void {
  const fontSize = s.fontSize
  const root = document.documentElement
  if (s.theme === 'light' || s.theme === 'dark') root.dataset.theme = s.theme
  else delete root.dataset.theme
  if (fontSize >= 11 && fontSize <= 22) root.style.setProperty('--font-size', `${fontSize}px`)
  const stack = FONT_STACKS[s.font]
  if (stack) root.style.setProperty('--font', stack)
  else root.style.removeProperty('--font')
}

export const useApp = create<AppState>((set, get) => ({
  view: 'chat',
  settingsTab: 'general',
  paletteOpen: false,
  sidebarCollapsed: false,
  sidebarMobileOpen: false,
  artifactPaneOpen: false,
  selectedProjectId: null,
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  usage: null,
  version: '',
  toasts: [],

  go: (view) => set({ view, sidebarMobileOpen: false }),
  openSettings: (tab) => set({ view: 'settings', settingsTab: tab ?? get().settingsTab, sidebarMobileOpen: false }),
  openProject: (id) => set({ view: 'projects', selectedProjectId: id, sidebarMobileOpen: false }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarMobile: (sidebarMobileOpen) => set({ sidebarMobileOpen }),
  setArtifactPane: (artifactPaneOpen) => set({ artifactPaneOpen }),

  async loadSettings() {
    try {
      const [s, version] = await Promise.all([api.settings.get(), api.app.version().catch(() => '')])
      const settings = { ...DEFAULT_SETTINGS, ...s }
      applyTheme(settings)
      set({ settings, settingsLoaded: true, version })
    } catch (err) {
      applyTheme(DEFAULT_SETTINGS)
      set({ settingsLoaded: true })
      get().toast(`Could not load settings: ${errorText(err)}`, 'error')
    }
  },

  async setSettings(patch) {
    const prev = get().settings
    const next = { ...prev, ...patch }
    set({ settings: next })
    applyTheme(next)
    try {
      await api.settings.set(patch)
    } catch (err) {
      set({ settings: prev })
      applyTheme(prev)
      get().toast(`Could not save setting: ${errorText(err)}`, 'error')
    }
  },

  async refreshUsage() {
    try {
      set({ usage: await api.usage.summary() })
    } catch {
      /* spend line just stays empty; Usage page shows the error */
    }
  },

  toast(text, kind = 'info') {
    const id = uid('toast')
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
