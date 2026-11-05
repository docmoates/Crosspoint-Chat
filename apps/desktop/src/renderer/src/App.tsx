import * as RTooltip from '@radix-ui/react-tooltip'
import { X } from 'lucide-react'
import { useEffect, type ReactElement } from 'react'
import { ArtifactPane } from './components/ArtifactPane'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { Spinner } from './components/ui/primitives'
import { hasBridge } from './lib/api'
import { cn } from './lib/utils'
import { ArtifactsPage } from './pages/ArtifactsPage'
import { ChatPage } from './pages/ChatPage'
import { PairingPage } from './pages/PairingPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { SettingsPage } from './pages/SettingsPage'
import { useApp } from './store/app'
import { isStreaming, useChat } from './store/chat'
import { useConfig } from './store/config'
import { usePairing } from './store/pairing'
import { useProjects } from './store/projects'

function Toasts(): ReactElement {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cn('toast flex items-start gap-2', t.kind === 'error' && 'error')}>
          <div className="flex-1">{t.text}</div>
          <button type="button" className="faint" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X className="ic-xs" />
          </button>
        </div>
      ))}
    </div>
  )
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const app = useApp.getState()
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        app.setPalette(false)
        useChat.getState().newChat()
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        app.setPalette(!app.paletteOpen)
      } else if (mod && e.key === ',') {
        e.preventDefault()
        app.openSettings()
      } else if (e.key === 'Escape' && !app.paletteOpen && isStreaming(useChat.getState())) {
        // Radix dialogs/popovers handle their own Escape first; only stop when nothing is open.
        if (document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]')) return
        e.preventDefault()
        void useChat.getState().stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function Shell(): ReactElement {
  const app = useApp()
  useShortcuts()

  useEffect(() => {
    const offConfig = useConfig.getState().init()
    const offChat = useChat.getState().init()
    void useProjects.getState().load()
    void useApp.getState().refreshUsage()
    const t = window.setInterval(() => void useApp.getState().refreshUsage(), 60_000)
    return () => {
      offConfig()
      offChat()
      window.clearInterval(t)
    }
  }, [])

  // A sync can change models, limits and spend; refetch when the status ticks.
  const lastSync = usePairing((s) => s.status?.lastSyncAt)
  useEffect(() => {
    if (!lastSync) return
    void useConfig.getState().load()
    void useApp.getState().refreshUsage()
  }, [lastSync])

  // Another PC changed chats, projects or memory.
  const dataVersion = usePairing((s) => s.status?.dataVersion ?? 0)
  useEffect(() => {
    if (dataVersion === 0) return
    void useChat.getState().loadList()
    void useChat.getState().reload()
    void useProjects.getState().load()
  }, [dataVersion])

  const showArtifacts = app.view === 'chat' && app.artifactPaneOpen
  return (
    <div
      className={cn(
        'app-shell',
        app.sidebarCollapsed && 'sb-collapsed',
        showArtifacts && 'artifact-open',
        app.sidebarMobileOpen && 'sb-mobile-open',
      )}
    >
      <Sidebar />
      {app.sidebarMobileOpen && (
        <div className="overlay mob-only" style={{ zIndex: 29 }} onClick={() => app.setSidebarMobile(false)} aria-hidden />
      )}
      <main className="main-col">
        {app.view === 'chat' && <ChatPage />}
        {app.view === 'projects' && <ProjectsPage />}
        {app.view === 'artifacts' && <ArtifactsPage />}
        {app.view === 'settings' && <SettingsPage />}
      </main>
      {showArtifacts && <ArtifactPane />}
      <CommandPalette />
    </div>
  )
}

export function App(): ReactElement {
  const pairingLoaded = usePairing((s) => s.loaded)
  const paired = usePairing((s) => s.status?.paired ?? false)
  const settingsLoaded = useApp((s) => s.settingsLoaded)
  const bridge = hasBridge()

  useEffect(() => {
    if (!bridge) return
    void useApp.getState().loadSettings()
    return usePairing.getState().init()
  }, [bridge])

  let body: ReactElement
  if (!bridge) {
    body = (
      <div className="pair-wrap">
        <div className="pair-card">
          <h1 style={{ fontSize: 20 }}>Crosspoint Chat</h1>
          <div className="notice error">The app bridge is missing. Start Crosspoint Chat from its desktop shortcut.</div>
        </div>
      </div>
    )
  } else if (!pairingLoaded || !settingsLoaded) {
    body = (
      <div className="pair-wrap">
        <div className="status-row">
          <Spinner /> Starting…
        </div>
      </div>
    )
  } else if (!paired) {
    body = <PairingPage />
  } else {
    body = <Shell />
  }

  return (
    <RTooltip.Provider delayDuration={350}>
      {body}
      <Toasts />
    </RTooltip.Provider>
  )
}
