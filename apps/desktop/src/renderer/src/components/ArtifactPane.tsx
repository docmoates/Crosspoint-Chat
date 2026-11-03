import * as Tabs from '@radix-ui/react-tabs'
import { ArrowLeft, Download, PanelRight, Save, X } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { artifactPreviewUrl } from '@shared/channels'
import { api, errorText } from '../lib/api'
import { relTime } from '../lib/utils'
import type { Artifact, ArtifactWithContent } from '../lib/types'
import { useApp } from '../store/app'
import { useArtifacts } from '../store/artifacts'
import { CopyButton, Markdown } from './Markdown'
import { Empty, ErrorLine, Soon, Spinner } from './ui/primitives'

type Loaded = ArtifactWithContent

function previewKind(a: Artifact): 'html' | 'svg' | 'markdown' | 'none' {
  if (a.kind === 'html' || a.kind === 'svg' || a.kind === 'markdown') return a.kind
  return 'none'
}

/**
 * HTML/SVG previews load from main's `crosspoint-artifact://` protocol, which serves the saved version
 * under its own CSP so inline scripts run. The sandbox has no allow-same-origin, so artifact code runs
 * in an opaque origin and can never reach window.crosspoint.
 */
function Preview(props: { a: Loaded }): ReactElement {
  const kind = previewKind(props.a)
  if (kind === 'html' || kind === 'svg') {
    return (
      <iframe
        className="preview-iframe"
        title={props.a.name}
        sandbox="allow-scripts allow-modals"
        src={artifactPreviewUrl(props.a.id, props.a.version)}
      />
    )
  }
  if (kind === 'markdown') {
    return (
      <div style={{ padding: 28, maxWidth: '64ch', margin: '0 auto', lineHeight: 1.65 }}>
        <Markdown text={props.a.content} />
      </div>
    )
  }
  return (
    <div className="p-6">
      <Empty title={`No live preview for ${props.a.kind === 'code' ? (props.a.language ?? 'code') : props.a.kind}`}>
        <div>
          Use the Code tab.{' '}
          {(props.a.kind === 'jsx' || props.a.kind === 'mermaid') && (
            <>
              Live {props.a.kind === 'jsx' ? 'React' : 'Mermaid'} previews are <Soon />
            </>
          )}
        </div>
      </Empty>
    </div>
  )
}

function Viewer(props: { id: string }): ReactElement {
  const [a, setA] = useState<Loaded | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('preview')
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    let alive = true
    setA(null)
    setError(null)
    api.artifacts
      .get(props.id)
      .then((x) => {
        if (!alive) return
        setA(x)
        setDraft(x.content)
        setTab(previewKind(x) === 'none' ? 'code' : 'preview')
      })
      .catch((err) => alive && setError(errorText(err)))
    return () => {
      alive = false
    }
  }, [props.id])

  if (error) return <div className="p-4"><ErrorLine error={error} /></div>
  if (!a)
    return (
      <div className="status-row p-4">
        <Spinner /> Loading artifact…
      </div>
    )

  const dirty = draft !== a.content
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.artifacts.save(a.id, draft)
      // Main stores a changed save as the next version; the new version also reloads the preview frame.
      setA({ ...a, content: draft, version: a.version + 1 })
      toast('Artifact saved')
    } catch (err) {
      toast(`Could not save: ${errorText(err)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Tabs.List className="tabs" aria-label="Artifact view">
          <Tabs.Trigger value="preview">Preview</Tabs.Trigger>
          <Tabs.Trigger value="code">Code</Tabs.Trigger>
        </Tabs.List>
        <span className="faint ml-auto text-[11px]">
          {a.language ?? a.kind} · v{a.version} · {relTime(a.updatedAt)}
        </span>
      </div>
      <div className="art-body">
        <Tabs.Content value="preview" className="h-full">
          <Preview a={{ ...a, content: draft }} />
        </Tabs.Content>
        <Tabs.Content value="code" className="h-full">
          <textarea
            className="mono h-full w-full resize-none border-0 bg-panel p-3 text-[12.5px] leading-[1.55] outline-none"
            value={draft}
            spellCheck={false}
            aria-label="Artifact source"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                if (dirty) void save()
              }
            }}
          />
        </Tabs.Content>
      </div>
      <div className="art-foot">
        <CopyButton text={draft} label className="btn sm" />
        <button type="button" className="btn sm" onClick={() => void api.artifacts.exportTo(a.id).catch((err) => toast(errorText(err), 'error'))}>
          <Download className="ic-sm" /> Export
        </button>
        <span className="flex-1" />
        {dirty && (
          <button type="button" className="btn sm" onClick={() => setDraft(a.content)}>
            Discard
          </button>
        )}
        <button type="button" className="btn sm primary" disabled={!dirty || saving} onClick={() => void save()}>
          <Save className="ic-sm" /> Save
        </button>
      </div>
    </Tabs.Root>
  )
}

export function ArtifactPane(): ReactElement {
  const setPane = useApp((s) => s.setArtifactPane)
  const { list, loading, error, selectedId, select, conversationId } = useArtifacts()
  const selected = list.find((a) => a.id === selectedId)

  return (
    <aside className="artpane" aria-label="Artifacts">
      <div className="art-head">
        <button type="button" className="iconbtn" title="Close" onClick={() => setPane(false)}>
          <X />
        </button>
        {selectedId && list.length > 0 && (
          <button type="button" className="iconbtn" title="All artifacts" onClick={() => select(null)}>
            <ArrowLeft />
          </button>
        )}
        <div className="title">{selected?.name ?? 'Artifacts'}</div>
      </div>
      {selectedId ? (
        <Viewer key={selectedId} id={selectedId} />
      ) : (
        <div className="art-body p-3">
          {error && <ErrorLine error={error} />}
          {loading && list.length === 0 && (
            <div className="status-row">
              <Spinner /> Loading…
            </div>
          )}
          {!loading && !error && list.length === 0 && (
            <Empty title={conversationId ? 'No artifacts in this chat yet' : 'Open a chat to see its artifacts'}>
              {conversationId &&
                'When the assistant makes an HTML page, SVG, document or code file, it appears here for preview and export.'}
            </Empty>
          )}
          <div className="flex flex-col gap-2">
            {list.map((a) => (
              <button key={a.id} type="button" className="artifact-chip" onClick={() => select(a.id)}>
                <span className="ic">
                  <PanelRight />
                </span>
                <span className="min-w-0">
                  <b className="truncate">{a.name}</b>
                  <small>
                    {a.language ?? a.kind} · {relTime(a.updatedAt)}
                  </small>
                </span>
                <span className="v">v{a.version}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}
