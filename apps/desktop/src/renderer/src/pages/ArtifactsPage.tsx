import { FileCode2, FileText, Image as ImageIcon, Menu, PanelLeft, PanelRight } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Empty, Seg, Spinner } from '../components/ui/primitives'
import { api } from '../lib/api'
import { relTime } from '../lib/utils'
import type { Artifact } from '../lib/types'
import { useApp } from '../store/app'
import { useArtifacts } from '../store/artifacts'
import { useChat } from '../store/chat'

type Filter = 'all' | 'pages' | 'documents' | 'code'

function category(a: Artifact): Exclude<Filter, 'all'> {
  if (a.kind === 'html' || a.kind === 'svg' || a.kind === 'jsx' || a.kind === 'mermaid') return 'pages'
  if (a.kind === 'markdown') return 'documents'
  return 'code'
}

const SCAN_LIMIT = 60

/**
 * The contract only lists artifacts per conversation, so the gallery reads the most recent chats
 * and merges their artifacts.
 */
export function ArtifactsPage(): ReactElement {
  const conversations = useChat((s) => s.conversations)
  const app = useApp()
  const [items, setItems] = useState<(Artifact & { chatTitle: string })[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const recent = useMemo(
    () =>
      conversations
        .filter((c) => !c.archived)
        .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt))
        .slice(0, SCAN_LIMIT),
    [conversations],
  )

  useEffect(() => {
    let alive = true
    Promise.all(
      recent.map((c) =>
        api.artifacts
          .list(c.id)
          .then((list) => list.map((a) => ({ ...a, chatTitle: c.title })))
          .catch(() => []),
      ),
    ).then((lists) => {
      if (!alive) return
      setItems(lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    })
    return () => {
      alive = false
    }
  }, [recent])

  const shown = (items ?? []).filter((a) => filter === 'all' || category(a) === filter)

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
        <div className="title">Artifacts</div>
        <span className="desk-only">
          <Seg
            label="Filter artifacts"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'pages', label: 'Pages' },
              { value: 'documents', label: 'Documents' },
              { value: 'code', label: 'Code' },
            ]}
          />
        </span>
      </div>
      <div className="page">
        <div className="page-inner">
          <h1>Artifacts</h1>
          {items === null && (
            <div className="status-row">
              <Spinner /> Collecting artifacts from your chats…
            </div>
          )}
          {items && shown.length === 0 && (
            <Empty title={items.length === 0 ? 'No artifacts yet' : 'Nothing in this filter'}>
              {items.length === 0 &&
                'Artifacts are pages, SVGs, documents and code files the assistant creates in a chat. They collect here.'}
            </Empty>
          )}
          <div className="gallery">
            {shown.map((a) => {
              const cat = category(a)
              return (
                <button
                  key={a.id}
                  type="button"
                  className="gcard"
                  onClick={async () => {
                    await useChat.getState().open(a.conversationId)
                    await useArtifacts.getState().load(a.conversationId)
                    useArtifacts.getState().openArtifact(a.id)
                  }}
                >
                  <div className="thumb">
                    {cat === 'pages' ? (
                      a.kind === 'svg' ? (
                        <ImageIcon style={{ width: 34, height: 34 }} />
                      ) : (
                        <PanelRight style={{ width: 34, height: 34 }} />
                      )
                    ) : cat === 'documents' ? (
                      <FileText style={{ width: 34, height: 34 }} />
                    ) : (
                      <FileCode2 style={{ width: 34, height: 34 }} />
                    )}
                  </div>
                  <div className="gb">
                    <b className="truncate">{a.name}</b>
                    <small>
                      {a.language ?? a.kind} · v{a.version} · {a.chatTitle || 'Untitled chat'} · {relTime(a.updatedAt)}
                    </small>
                  </div>
                </button>
              )
            })}
          </div>
          {conversations.length > SCAN_LIMIT && (
            <div className="faint text-[12px]">Showing artifacts from your {SCAN_LIMIT} most recent chats.</div>
          )}
        </div>
      </div>
    </section>
  )
}
