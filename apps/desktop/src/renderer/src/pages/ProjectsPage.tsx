import { FileText, FolderClosed, Menu, PanelLeft, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { ConfirmDialog, PromptDialog } from '../components/ui/dialogs'
import { Empty, ErrorLine, Spinner } from '../components/ui/primitives'
import { api, errorText } from '../lib/api'
import { bytes, cn, relTime } from '../lib/utils'
import type { ConversationSummary, Project, ProjectFile } from '../lib/types'
import { useApp } from '../store/app'
import { useChat } from '../store/chat'
import { useProjects } from '../store/projects'

function ProjectDetail(props: { project: Project }): ReactElement {
  const { project } = props
  const { update, remove } = useProjects.getState()
  const toast = useApp((s) => s.toast)
  const openProject = useApp((s) => s.openProject)
  const chatListVersion = useChat((s) => s.conversations)
  const [instructions, setInstructions] = useState(project.instructions ?? '')
  const [files, setFiles] = useState<ProjectFile[] | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [chats, setChats] = useState<ConversationSummary[] | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => setInstructions(project.instructions ?? ''), [project.id, project.instructions])

  useEffect(() => {
    let alive = true
    setFiles(null)
    api.projects.files
      .list(project.id)
      .then((f) => alive && setFiles(f))
      .catch((err) => alive && setFilesError(errorText(err)))
    return () => {
      alive = false
    }
  }, [project.id])

  useEffect(() => {
    let alive = true
    api.conversations
      .list({ projectId: project.id, limit: 200 })
      .then((c) => alive && setChats(c.filter((x) => !x.archived)))
      .catch(() => alive && setChats([]))
    return () => {
      alive = false
    }
  }, [project.id, chatListVersion])

  const addFiles = async (): Promise<void> => {
    setAdding(true)
    try {
      const added = await api.projects.files.add(project.id)
      if (added.length) setFiles(await api.projects.files.list(project.id))
    } catch (err) {
      toast(`Could not add files: ${errorText(err)}`, 'error')
    } finally {
      setAdding(false)
    }
  }

  const removeFile = async (id: string): Promise<void> => {
    try {
      await api.projects.files.remove(id)
      setFiles((f) => f?.filter((x) => x.id !== id) ?? null)
    } catch (err) {
      toast(`Could not remove file: ${errorText(err)}`, 'error')
    }
  }

  return (
    <div className="page-inner">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate">{project.name}</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Created {relTime(project.createdAt)}
          </p>
        </div>
        <button type="button" className="btn sm" onClick={() => setRenaming(true)}>
          Rename
        </button>
        <button type="button" className="btn sm danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="ic-sm" /> Delete
        </button>
        <button type="button" className="btn sm primary" onClick={() => useChat.getState().newChat(project.id)}>
          <Plus className="ic-sm" /> New chat in project
        </button>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Instructions</h3>
          <textarea
            className="input"
            style={{ minHeight: 160 }}
            value={instructions}
            placeholder="Instructions every chat in this project starts with, e.g. your role, audience and preferred style."
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => {
              if (instructions !== (project.instructions ?? '')) void update(project.id, { instructions })
            }}
          />
          <div className="faint mt-1 text-[11px]">Saved when you click away.</div>
        </div>
        <div className="card">
          <h3>
            Knowledge
            {files && files.length > 0 && <span className="tag">{files.length} files</span>}
          </h3>
          <ErrorLine error={filesError} />
          {files === null && !filesError && (
            <div className="status-row">
              <Spinner /> Loading files…
            </div>
          )}
          {files && files.length === 0 && (
            <div className="muted text-[13px]">No files yet. Add documents the chats in this project should know about.</div>
          )}
          {files && files.length > 0 && (
            <div className="list">
              {files.map((f) => (
                <div className="row" key={f.id}>
                  <FileText className="ic-sm" />
                  <div className="grow">
                    {f.name}
                    <small>
                      {[bytes(f.size), f.mime, f.textChars > 0 ? `${f.textChars.toLocaleString('en-US')} characters readable` : 'no extractable text']
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </div>
                  <button type="button" className="iconbtn" title={`Remove ${f.name}`} onClick={() => void removeFile(f.id)}>
                    <X className="ic-sm" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button type="button" className="btn sm" onClick={() => void addFiles()} disabled={adding}>
              {adding ? <Spinner /> : <Plus className="ic-sm" />} Add files
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Chats in this project</h3>
        {chats === null && (
          <div className="status-row">
            <Spinner /> Loading…
          </div>
        )}
        {chats && chats.length === 0 && (
          <div className="muted text-[13px]">No chats yet. Use New chat in project, or move a chat here from its menu in the sidebar.</div>
        )}
        {chats && chats.length > 0 && (
          <div className="list">
            {chats.map((c) => (
              <button type="button" className="row" key={c.id} onClick={() => void useChat.getState().open(c.id)}>
                <div className="grow">
                  {c.title || 'Untitled chat'}
                  <small>
                    {[relTime(c.lastMessageAt ?? c.updatedAt), `${c.messageCount} messages`, c.preview].filter(Boolean).join(' · ')}
                  </small>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename project"
        label="Name"
        initial={project.name}
        confirmLabel="Save"
        onConfirm={(name) => update(project.id, { name: name.trim() })}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this project?"
        description={`"${project.name}", its instructions and knowledge files are removed. Chats in it are kept.`}
        confirmLabel="Delete project"
        danger
        onConfirm={async () => {
          await remove(project.id)
          openProject(null)
        }}
      />
    </div>
  )
}

export function ProjectsPage(): ReactElement {
  const { projects, loaded, error, load, create } = useProjects()
  const app = useApp()
  const [creating, setCreating] = useState(false)
  const selected = projects.find((p) => p.id === app.selectedProjectId) ?? null

  useEffect(() => {
    void load()
  }, [load])

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
        <div className="title">{selected ? `Project · ${selected.name}` : 'Projects'}</div>
        {selected && (
          <button type="button" className="btn sm" onClick={() => app.openProject(null)}>
            All projects
          </button>
        )}
        <button type="button" className="btn sm primary" onClick={() => setCreating(true)}>
          <Plus className="ic-sm" /> New project
        </button>
      </div>
      <div className="page">
        {selected ? (
          <ProjectDetail key={selected.id} project={selected} />
        ) : (
          <div className="page-inner">
            <h1>Projects</h1>
            <ErrorLine error={error} />
            {!loaded && (
              <div className="status-row">
                <Spinner /> Loading projects…
              </div>
            )}
            {loaded && projects.length === 0 && !error && (
              <Empty
                title="No projects yet"
                action={
                  <button type="button" className="btn sm primary" onClick={() => setCreating(true)}>
                    <Plus className="ic-sm" /> New project
                  </button>
                }
              >
                A project keeps instructions, knowledge files and its chats together.
              </Empty>
            )}
            <div className="gallery">
              {projects.map((p) => (
                <button key={p.id} type="button" className={cn('gcard')} onClick={() => app.openProject(p.id)}>
                  <div className="thumb">
                    <FolderClosed style={{ width: 34, height: 34 }} />
                  </div>
                  <div className="gb">
                    <b>{p.name}</b>
                    <small>
                      {p.instructions ? p.instructions.slice(0, 80) : 'No instructions'} · {relTime(p.updatedAt)}
                    </small>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <PromptDialog
        open={creating}
        onOpenChange={setCreating}
        title="New project"
        label="Name"
        placeholder="e.g. PSYC 301 course"
        confirmLabel="Create"
        onConfirm={async (name) => {
          const p = await create(name)
          if (p) app.openProject(p.id)
        }}
      />
    </section>
  )
}
