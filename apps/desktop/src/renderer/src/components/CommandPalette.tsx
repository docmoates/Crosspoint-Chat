import * as Dialog from '@radix-ui/react-dialog'
import { Activity, FolderClosed, MessageCircle, Moon, PanelRight, Plus, Search, Settings } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { api } from '../lib/api'
import { cn, relTime } from '../lib/utils'
import type { ConversationSummary } from '../lib/types'
import { useApp } from '../store/app'
import { useChat } from '../store/chat'
import { useProjects } from '../store/projects'
import { Spinner } from './ui/primitives'

interface Item {
  id: string
  group: string
  icon: ReactNode
  label: string
  sub?: string
  right?: ReactNode
  run(): void
}

export function CommandPalette(): ReactElement {
  const app = useApp()
  const projects = useProjects((s) => s.projects)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<ConversationSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [sel, setSel] = useState(0)
  const open = app.paletteOpen

  useEffect(() => {
    if (!open) {
      setQ('')
      setSel(0)
      return
    }
    let alive = true
    setSearching(true)
    const t = window.setTimeout(() => {
      api.conversations
        .list({ search: q.trim() || undefined, limit: q.trim() ? 30 : 8 })
        .then((r) => alive && setResults(r))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setSearching(false))
    }, 150)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [q, open])

  const items = useMemo<Item[]>(() => {
    const close = (): void => app.setPalette(false)
    const needle = q.trim().toLowerCase()
    const chats: Item[] = results.map((c) => ({
      id: `c:${c.id}`,
      group: needle ? 'Chats' : 'Recent chats',
      icon: <MessageCircle className="ic-sm" />,
      label: c.title || 'Untitled chat',
      sub: c.projectId ? projects.find((p) => p.id === c.projectId)?.name : undefined,
      right: <span className="faint text-[11px]">{relTime(c.lastMessageAt ?? c.updatedAt)}</span>,
      run: () => {
        close()
        void useChat.getState().open(c.id)
      },
    }))
    const projItems: Item[] = projects
      .filter((p) => needle && p.name.toLowerCase().includes(needle))
      .map((p) => ({
        id: `p:${p.id}`,
        group: 'Projects',
        icon: <FolderClosed className="ic-sm" />,
        label: p.name,
        run: () => {
          close()
          app.openProject(p.id)
        },
      }))
    const commands: Item[] = [
      {
        id: 'new',
        group: 'Commands',
        icon: <Plus className="ic-sm" />,
        label: 'New chat',
        right: <kbd>Ctrl N</kbd>,
        run: () => {
          close()
          useChat.getState().newChat()
        },
      },
      {
        id: 'settings',
        group: 'Commands',
        icon: <Settings className="ic-sm" />,
        label: 'Open settings',
        right: <kbd>Ctrl ,</kbd>,
        run: () => {
          close()
          app.openSettings('general')
        },
      },
      {
        id: 'theme',
        group: 'Commands',
        icon: <Moon className="ic-sm" />,
        label: 'Toggle theme',
        run: () => {
          const dark =
            app.settings.theme === 'dark' ||
            (app.settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
          void app.setSettings({ theme: dark ? 'light' : 'dark' })
          close()
        },
      },
      {
        id: 'artifacts',
        group: 'Commands',
        icon: <PanelRight className="ic-sm" />,
        label: 'Browse artifacts',
        run: () => {
          close()
          app.go('artifacts')
        },
      },
      {
        id: 'projects',
        group: 'Commands',
        icon: <FolderClosed className="ic-sm" />,
        label: 'Projects',
        run: () => {
          close()
          app.openProject(app.selectedProjectId)
        },
      },
      {
        id: 'health',
        group: 'Commands',
        icon: <Activity className="ic-sm" />,
        label: 'Check health',
        run: () => {
          close()
          app.openSettings('health')
        },
      },
    ].filter((c) => !needle || c.label.toLowerCase().includes(needle))
    return [...chats, ...projItems, ...commands]
  }, [results, projects, q, app])

  useEffect(() => setSel(0), [q])

  let lastGroup = ''
  return (
    <Dialog.Root open={open} onOpenChange={app.setPalette}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="pal" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="in">
            <Search />
            <input
              autoFocus
              value={q}
              placeholder="Search chats, run a command, jump to a project…"
              aria-label="Search"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSel((s) => Math.min(items.length - 1, s + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSel((s) => Math.max(0, s - 1))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  items[sel]?.run()
                }
              }}
            />
            {searching ? <Spinner /> : <kbd>Esc</kbd>}
          </div>
          <div className="body">
            {items.length === 0 && !searching && (
              <div className="px-3 py-4 text-[13px] muted">Nothing matches "{q}".</div>
            )}
            {items.map((it, i) => {
              const header = it.group !== lastGroup ? it.group : null
              lastGroup = it.group
              return (
                <div key={it.id}>
                  {header && <div className="eyebrow" style={{ padding: '8px 8px 4px' }}>{header}</div>}
                  <button
                    type="button"
                    className={cn('menu-item', i === sel && 'sel')}
                    onMouseEnter={() => setSel(i)}
                    onClick={it.run}
                  >
                    {it.icon}
                    <span className="min-w-0 truncate">
                      {it.label}
                      {it.sub && <span className="sub">{it.sub}</span>}
                    </span>
                    {it.right && <span className="right">{it.right}</span>}
                  </button>
                </div>
              )
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
