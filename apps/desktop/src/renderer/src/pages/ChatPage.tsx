import { FolderClosed, Menu, PanelLeft, PanelRight } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react'
import { Composer } from '../components/Composer'
import { MessageView } from '../components/MessageView'
import { Spinner } from '../components/ui/primitives'
import { useApp } from '../store/app'
import { useArtifacts } from '../store/artifacts'
import { isStreaming, useChat, type UIMessage } from '../store/chat'
import { useConfig } from '../store/config'
import { useProjects } from '../store/projects'
import { usePairing } from '../store/pairing'
import type { Artifact } from '../lib/types'

const NO_ARTIFACTS: Artifact[] = []

function EmptyChat(): ReactElement {
  const models = useConfig((s) => s.models)
  const configError = useConfig((s) => s.error)
  const draft = useChat((s) => s.draft)
  const project = useProjects((s) => s.projects.find((p) => p.id === draft.projectId))
  const openSettings = useApp((s) => s.openSettings)
  const syncNow = usePairing((s) => s.syncNow)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <div className="brand" style={{ flex: 'none', fontSize: 22 }}>
        <span className="logo" style={{ width: 34, height: 34, fontSize: 15, borderRadius: 9 }}>
          X
        </span>
        {project ? `New chat in ${project.name}` : 'What can I help with?'}
      </div>
      {models.length === 0 ? (
        <p className="muted max-w-md text-[13px]">
          No models are available yet. Models come from admin after a sync.{' '}
          {configError && <span className="faint">({configError}) </span>}
          <button type="button" className="note-link underline" style={{ color: 'var(--accent)' }} onClick={() => void syncNow()}>
            Sync now
          </button>{' '}
          or{' '}
          <button type="button" className="underline" style={{ color: 'var(--accent)' }} onClick={() => openSettings('health')}>
            check Health
          </button>
          .
        </p>
      ) : (
        <p className="faint text-[13px]">Type a message below. Paste or drop files to attach them.</p>
      )}
    </div>
  )
}

export function ChatPage(): ReactElement {
  const conversation = useChat((s) => s.conversation)
  const currentId = useChat((s) => s.currentId)
  const messages = useChat((s) => s.messages)
  const loading = useChat((s) => s.loading)
  const loadError = useChat((s) => s.loadError)
  const busy = useChat(isStreaming)
  const artifactsVersion = useChat((s) => s.artifactsVersion)
  const { send, regenerate } = useChat.getState()
  const models = useConfig((s) => s.models)
  const projects = useProjects((s) => s.projects)
  const app = useApp()
  const artifacts = useArtifacts()

  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    void useArtifacts.getState().load(currentId)
  }, [currentId, artifactsVersion])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    stick.current = true
  }, [currentId])

  const byMessage = useMemo(() => {
    const map = new Map<string, Artifact[]>()
    for (const a of artifacts.list) {
      if (!a.messageId) continue
      const arr = map.get(a.messageId) ?? []
      arr.push(a)
      map.set(a.messageId, arr)
    }
    return map
  }, [artifacts.list])

  const onResend = useCallback((text: string, m: UIMessage) => void send(text, m.attachments ?? []), [send])
  const onRegenerate = useCallback((key: string, modelId?: string) => void regenerate(key, modelId), [regenerate])
  const onOpenArtifact = useCallback((id: string) => useArtifacts.getState().openArtifact(id), [])

  const project = projects.find((p) => p.id === conversation?.projectId)
  const unattached = artifacts.list.filter((a) => !a.messageId || !messages.some((m) => m.id === a.messageId))

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="topbar">
        <button type="button" className="iconbtn mob-only" title="Menu" onClick={() => app.setSidebarMobile(true)}>
          <Menu />
        </button>
        {app.sidebarCollapsed && (
          <button type="button" className="iconbtn desk-only" title="Show sidebar" onClick={app.toggleSidebar}>
            <PanelLeft />
          </button>
        )}
        <div className="title">{conversation?.title || (currentId ? '' : 'New chat')}</div>
        {project && (
          <button type="button" className="pill desk-only" onClick={() => app.openProject(project.id)}>
            <FolderClosed className="ic-xs" /> {project.name}
          </button>
        )}
        <button
          type="button"
          className={app.artifactPaneOpen ? 'pill on' : 'pill'}
          title={app.artifactPaneOpen ? 'Close artifacts' : 'Open artifacts'}
          onClick={() => app.setArtifactPane(!app.artifactPaneOpen)}
          disabled={!currentId}
        >
          <PanelRight className="ic-sm" />
          <span className="desk-only">Artifacts</span>
          {artifacts.list.length > 0 && <span className="faint">{artifacts.list.length}</span>}
        </button>
      </div>

      <div
        className="thread"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {loading && (
          <div className="thread-inner">
            <div className="status-row">
              <Spinner /> Loading chat…
            </div>
          </div>
        )}
        {loadError && (
          <div className="thread-inner">
            <div className="notice error">Could not open this chat: {loadError}</div>
          </div>
        )}
        {!loading && !loadError && messages.length === 0 && (
          <div className="flex h-full flex-col">
            <EmptyChat />
          </div>
        )}
        {messages.length > 0 && (
          <div className="thread-inner">
            {messages.map((m) => (
              <MessageView
                key={m.key}
                m={m}
                models={models}
                busy={busy}
                artifacts={(m.id && byMessage.get(m.id)) || NO_ARTIFACTS}
                activeArtifactId={app.artifactPaneOpen ? artifacts.selectedId : null}
                onResend={onResend}
                onRegenerate={onRegenerate}
                onOpenArtifact={onOpenArtifact}
              />
            ))}
            {unattached.length > 0 && !busy && (
              <div className="faint text-[12px]">
                {unattached.length} artifact{unattached.length === 1 ? '' : 's'} in this chat ·{' '}
                <button type="button" className="underline" onClick={() => app.setArtifactPane(true)}>
                  open panel
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <Composer />
    </section>
  )
}
