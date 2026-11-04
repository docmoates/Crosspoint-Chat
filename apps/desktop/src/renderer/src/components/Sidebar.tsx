import * as DM from '@radix-ui/react-dropdown-menu'
import {
  Archive,
  Code2,
  FolderClosed,
  FolderInput,
  MessageCircle,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { useMemo, useState, type ReactElement } from 'react'
import { cn, dayGroup, initials, relTime, usd } from '../lib/utils'
import type { ConversationSummary } from '../lib/types'
import { useApp } from '../store/app'
import { useChat } from '../store/chat'
import { usePairing } from '../store/pairing'
import { useProjects } from '../store/projects'
import { ConfirmDialog } from './ui/dialogs'
import { Soon, Spinner, Tip } from './ui/primitives'

function ConversationRow(props: { c: ConversationSummary; active: boolean; running: boolean }): ReactElement {
  const { c } = props
  const chat = useChat.getState()
  const projects = useProjects((s) => s.projects)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(c.title)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (renaming) {
    return (
      <form
        className="sb-row"
        onSubmit={(e) => {
          e.preventDefault()
          void chat.rename(c.id, title)
          setRenaming(false)
        }}
      >
        <input
          className="input"
          style={{ padding: '5px 8px' }}
          value={title}
          autoFocus
          aria-label="Chat title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() && title !== c.title) void chat.rename(c.id, title)
            setRenaming(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setTitle(c.title)
              setRenaming(false)
            }
          }}
        />
      </form>
    )
  }

  return (
    <div className="sb-row">
      <button
        type="button"
        className={cn('sb-item', props.active && 'on')}
        onClick={() => void chat.open(c.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuOpen(true)
        }}
        onDoubleClick={() => {
          setTitle(c.title)
          setRenaming(true)
        }}
        title={c.title}
      >
        {c.pinned && <span className="dot" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent)', flex: 'none' }} />}
        <span>{c.title || 'Untitled chat'}</span>
        {props.running && (
          <span className="sb-badge" title="Answering">
            <Spinner size={7} />
          </span>
        )}
      </button>
      <DM.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DM.Trigger asChild>
          <button type="button" className="sb-more" aria-label={`Options for ${c.title}`}>
            <MoreHorizontal className="ic-sm" />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content className="menu" style={{ minWidth: 200 }} align="start" sideOffset={4}>
            <DM.Item
              className="menu-item"
              onSelect={() => {
                setTitle(c.title)
                setRenaming(true)
              }}
            >
              <Pencil className="ic-sm" /> Rename
            </DM.Item>
            <DM.Item className="menu-item" onSelect={() => void chat.setPinned(c.id, !c.pinned)}>
              {c.pinned ? <PinOff className="ic-sm" /> : <Pin className="ic-sm" />} {c.pinned ? 'Unpin' : 'Pin'}
            </DM.Item>
            <DM.Sub>
              <DM.SubTrigger className="menu-item">
                <FolderInput className="ic-sm" /> Move to project
              </DM.SubTrigger>
              <DM.Portal>
                <DM.SubContent className="menu" style={{ minWidth: 200 }} sideOffset={4}>
                  {c.projectId && (
                    <DM.Item className="menu-item" onSelect={() => void chat.moveToProject(c.id, null)}>
                      No project
                    </DM.Item>
                  )}
                  {projects.length === 0 && (
                    <DM.Item className="menu-item" disabled>
                      No projects yet
                    </DM.Item>
                  )}
                  {projects
                    .filter((p) => p.id !== c.projectId)
                    .map((p) => (
                      <DM.Item key={p.id} className="menu-item" onSelect={() => void chat.moveToProject(c.id, p.id)}>
                        <FolderClosed className="ic-sm" /> {p.name}
                      </DM.Item>
                    ))}
                </DM.SubContent>
              </DM.Portal>
            </DM.Sub>
            <DM.Item className="menu-item" onSelect={() => void chat.archive(c.id)}>
              <Archive className="ic-sm" /> Archive
            </DM.Item>
            <DM.Separator className="menu-sep" />
            <DM.Item className="menu-item danger" onSelect={() => setConfirmDelete(true)}>
              <Trash2 className="ic-sm" /> Delete
            </DM.Item>
          </DM.Content>
        </DM.Portal>
      </DM.Root>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this chat?"
        description={`"${c.title || 'Untitled chat'}" and its messages will be removed from this PC.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => chat.remove(c.id)}
      />
    </div>
  )
}

export function Sidebar(): ReactElement {
  const app = useApp()
  const conversations = useChat((s) => s.conversations)
  const listLoaded = useChat((s) => s.listLoaded)
  const listError = useChat((s) => s.listError)
  const currentId = useChat((s) => s.currentId)
  const runs = useChat((s) => s.runs)
  const newChat = useChat((s) => s.newChat)
  const pairing = usePairing()

  const runningIds = useMemo(() => new Set(Object.values(runs).map((r) => r.conversationId)), [runs])

  const groups = useMemo(() => {
    const visible = conversations.filter((c) => !c.archived)
    const pinned = visible.filter((c) => c.pinned)
    const rest = visible
      .filter((c) => !c.pinned)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt))
    const out: { label: string; items: ConversationSummary[] }[] = []
    if (pinned.length) out.push({ label: 'Pinned', items: pinned })
    for (const c of rest) {
      const label = dayGroup(c.lastMessageAt ?? c.updatedAt)
      const g = out.find((x) => x.label === label)
      if (g) g.items.push(c)
      else out.push({ label, items: [c] })
    }
    return out
  }, [conversations])

  const status = pairing.status
  const syncState: 'ok' | 'warn' | 'bad' = !status?.paired ? 'bad' : status.error ? 'warn' : 'ok'
  const syncTip = !status?.paired
    ? 'Not paired'
    : status.error
      ? `Sync problem: ${status.error}`
      : status.lastSyncAt
        ? `Synced with ${status.host} ${relTime(status.lastSyncAt)}. Click to sync now.`
        : `Paired with ${status.host}. Click to sync now.`
  const usage = app.usage
  const spendLine = usage
    ? `${usd(usage.month_usd, 2)} this month${usage.local_share > 0 ? ` · ${Math.round(usage.local_share * 100)}% answered locally` : ''}`
    : 'Spend loads after the first sync'

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sb-top">
        <div className="brand">
          <span className="logo">X</span> Crosspoint
        </div>
        <button type="button" className="iconbtn desk-only" title="Collapse sidebar" onClick={app.toggleSidebar}>
          <PanelLeft />
        </button>
        <button type="button" className="iconbtn mob-only" title="Close" onClick={() => app.setSidebarMobile(false)}>
          <X />
        </button>
      </div>
      <button type="button" className="newchat" onClick={() => newChat()}>
        <Plus /> New chat <kbd>Ctrl N</kbd>
      </button>
      <button type="button" className="sb-search" onClick={() => app.setPalette(true)}>
        <Search /> Search <kbd style={{ marginLeft: 'auto' }}>Ctrl K</kbd>
      </button>
      <nav className="sb-nav" aria-label="Sections">
        <button type="button" className={cn('sb-item', app.view === 'chat' && 'on')} onClick={() => app.go('chat')}>
          <MessageCircle />
          <span>Chats</span>
        </button>
        <button
          type="button"
          className={cn('sb-item', app.view === 'projects' && 'on')}
          onClick={() => app.openProject(app.selectedProjectId)}
        >
          <FolderClosed />
          <span>Projects</span>
        </button>
        <button type="button" className={cn('sb-item', app.view === 'artifacts' && 'on')} onClick={() => app.go('artifacts')}>
          <PanelRight />
          <span>Artifacts</span>
        </button>
        <button type="button" className="sb-item" disabled title="Coding agent workspace">
          <Code2 />
          <span>Code</span>
          <Soon className="ml-auto" />
        </button>
      </nav>
      <div className="sb-scroll">
        {listError && (
          <div className="sb-group">
            <div className="notice error">Could not load chats: {listError}</div>
          </div>
        )}
        {listLoaded && !listError && groups.length === 0 && (
          <div className="sb-group px-2 text-[12.5px] faint">No chats yet. Start one with New chat or Ctrl+N.</div>
        )}
        {groups.map((g) => (
          <div className="sb-group" key={g.label}>
            <div className="eyebrow">{g.label}</div>
            {g.items.map((c) => (
              <ConversationRow key={c.id} c={c} active={c.id === currentId} running={runningIds.has(c.id)} />
            ))}
          </div>
        ))}
      </div>
      <div className="sb-bottom">
        <div className="avatar">{initials(status?.device?.name)}</div>
        <div className="who">
          {status?.device?.name ?? 'This PC'}
          <small title={spendLine}>{spendLine}</small>
        </div>
        <Tip content={syncTip}>
          <button
            type="button"
            className="iconbtn"
            aria-label={syncTip}
            onClick={() => (status?.paired ? void pairing.syncNow() : app.openSettings('device'))}
          >
            {pairing.syncing ? (
              <RefreshCw className="animate-spin" />
            ) : (
              <span className={cn('sdot', syncState)} style={{ width: 9, height: 9 }} />
            )}
          </button>
        </Tip>
        <button type="button" className="iconbtn" title="Settings" onClick={() => app.openSettings()}>
          <Settings />
        </button>
      </div>
    </aside>
  )
}
