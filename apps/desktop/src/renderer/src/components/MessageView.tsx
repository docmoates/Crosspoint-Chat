import * as DM from '@radix-ui/react-dropdown-menu'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  Hexagon,
  Image as ImageIcon,
  Info,
  Lightbulb,
  PanelRight,
  Pencil,
  RotateCcw,
  Wrench,
} from 'lucide-react'
import { memo, useState, type ReactElement } from 'react'
import { bytes, cn } from '../lib/utils'
import type { Artifact, ModelInfo } from '../lib/types'
import type { UIMessage } from '../store/chat'
import { defaultChatModel, providerLabel, useConfig } from '../store/config'
import { CopyButton, Markdown } from './Markdown'
import { modelName } from './ModelPicker'
import { Spinner } from './ui/primitives'
import { UsagePopover } from './UsagePopover'

function Attachments(props: { m: UIMessage }): ReactElement | null {
  if (!props.m.attachments.length) return null
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {props.m.attachments.map((a) => (
        <span className="attach" key={a.id}>
          {a.kind === 'image' ? <ImageIcon className="ic-sm" /> : <FileText className="ic-sm" />}
          {a.name} · {bytes(a.size)}
        </span>
      ))}
    </div>
  )
}

function stringify(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function UserMessage(props: { m: UIMessage; busy: boolean; onResend: (text: string) => void }): ReactElement {
  const { m } = props
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(m.content)
  if (editing) {
    return (
      <div className="msg user">
        <div className="composer w-full" style={{ maxWidth: '80%', marginRight: 0 }}>
          <textarea
            value={text}
            autoFocus
            rows={Math.min(10, Math.max(2, text.split('\n').length))}
            aria-label="Edit message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <div className="row">
            <span className="grow faint text-[11px] pl-1">Sends the edited text as a new message</span>
            <button type="button" className="btn sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn sm primary"
              disabled={!text.trim() || props.busy}
              onClick={() => {
                setEditing(false)
                props.onResend(text)
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="msg user">
      <Attachments m={m} />
      {m.content && <div className="bubble">{m.content}</div>}
      <div className="actions">
        <button
          type="button"
          title="Edit and resend"
          disabled={props.busy}
          onClick={() => {
            setText(m.content)
            setEditing(true)
          }}
        >
          <Pencil className="ic-sm" />
        </button>
        <CopyButton text={m.content} />
      </div>
    </div>
  )
}

function Thinking(props: { m: UIMessage }): ReactElement | null {
  const { m } = props
  if (!m.thinking) return null
  const live = m.streaming && !m.content
  const label = live
    ? 'Thinking…'
    : m.thinkingMs != null
      ? `Thought for ${Math.max(1, Math.round(m.thinkingMs / 1000))} second${Math.round(m.thinkingMs / 1000) > 1 ? 's' : ''}`
      : 'Thinking'
  return (
    <details className="block thinking" open={live || undefined}>
      <summary>
        {live ? <Spinner /> : <Lightbulb className="ic-sm" />} {label}
        <ChevronRight className="chev ic-sm" />
      </summary>
      <div className="inner">{m.thinking}</div>
    </details>
  )
}

function AssistantMessage(props: {
  m: UIMessage
  models: ModelInfo[]
  artifacts: Artifact[]
  activeArtifactId: string | null
  canRegenerate: boolean
  onRegenerate: (modelId?: string) => void
  onOpenArtifact: (id: string) => void
}): ReactElement {
  const { m, models } = props
  const config = useConfig((s) => s.config)
  const shownModelId = m.modelId ?? defaultChatModel(config)
  const model = models.find((x) => x.id === shownModelId)
  const waiting = m.streaming && !m.content && !m.thinking && !m.error
  return (
    <div className="msg assistant">
      <div className="meta">
        <span className="model">
          <Hexagon className="ic-sm" /> {shownModelId ? modelName(models, shownModelId) : 'Assistant'}
        </span>
        {(m.provider ?? model?.provider) && <span>· via {providerLabel(config, m.provider ?? model?.provider ?? '')}</span>}
        {m.stopped && <span>· stopped</span>}
      </div>
      <div className="body">
        <Thinking m={m} />
        {m.tools.map((t) => (
          <details className="block" key={t.id}>
            <summary>
              {t.done ? <Wrench className="ic-sm" /> : <Spinner />} {t.done ? 'Used' : 'Using'} <code>{t.name}</code>
              {t.isError && <span style={{ color: 'var(--bad)' }}>· failed</span>}
              <ChevronRight className="chev ic-sm" />
            </summary>
            <div className="inner mono text-[12px]">
              {stringify(t.input)}
              {t.output != null && `\n\n→ ${stringify(t.output)}`}
            </div>
          </details>
        ))}
        {m.notices.map((n, i) => (
          <div key={i} className={cn('notice', n.level === 'warn' && 'warn', n.level === 'error' && 'error')}>
            {n.level === 'info' ? <Info className="ic-sm" /> : <AlertTriangle className="ic-sm" />}
            <div className="flex-1">{n.text}</div>
          </div>
        ))}
        {m.content && <Markdown text={m.content} />}
        {waiting && (
          <div className="status-row">
            <Spinner /> Waiting for the model…
          </div>
        )}
        {m.error && (
          <div className="notice error" role="alert">
            <AlertTriangle className="ic-sm" style={{ color: 'var(--bad)' }} />
            <div className="flex-1">{m.error}</div>
            {props.canRegenerate && !m.streaming && (
              <button type="button" className="btn sm" onClick={() => props.onRegenerate()}>
                Retry
              </button>
            )}
          </div>
        )}
        {props.artifacts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={cn('artifact-chip', props.activeArtifactId === a.id && 'on')}
            onClick={() => props.onOpenArtifact(a.id)}
          >
            <span className="ic">
              <PanelRight />
            </span>
            <span>
              <b>{a.name}</b>
              <small>{a.kind.toUpperCase()}</small>
            </span>
            <span className="v">v{a.version}</span>
          </button>
        ))}
      </div>
      {!m.streaming && (
        <div className="actions">
          <CopyButton text={m.content} />
          {props.canRegenerate && (
            <>
              <button type="button" title="Regenerate" onClick={() => props.onRegenerate()}>
                <RotateCcw className="ic-sm" />
              </button>
              {models.length > 1 && (
                <DM.Root>
                  <DM.Trigger asChild>
                    <button type="button" title="Regenerate with another model" style={{ width: 18 }}>
                      <ChevronDown className="ic-xs" />
                    </button>
                  </DM.Trigger>
                  <DM.Portal>
                    <DM.Content className="menu" side="top" align="start" sideOffset={4} style={{ maxHeight: 360 }}>
                      <div className="eyebrow">Regenerate with</div>
                      {models.map((x) => (
                        <DM.Item key={x.id} className="menu-item" onSelect={() => props.onRegenerate(x.id)}>
                          {x.name}
                          <span className="right">{providerLabel(config, x.provider)}</span>
                        </DM.Item>
                      ))}
                    </DM.Content>
                  </DM.Portal>
                </DM.Root>
              )}
            </>
          )}
          <UsagePopover messageId={m.id} usage={m.usage} models={models} />
        </div>
      )}
    </div>
  )
}

export const MessageView = memo(function MessageView(props: {
  m: UIMessage
  models: ModelInfo[]
  busy: boolean
  artifacts: Artifact[]
  activeArtifactId: string | null
  onResend: (text: string, m: UIMessage) => void
  onRegenerate: (key: string, modelId?: string) => void
  onOpenArtifact: (id: string) => void
}): ReactElement {
  if (props.m.role === 'user') {
    return <UserMessage m={props.m} busy={props.busy} onResend={(t) => props.onResend(t, props.m)} />
  }
  return (
    <AssistantMessage
      m={props.m}
      models={props.models}
      artifacts={props.artifacts}
      activeArtifactId={props.activeArtifactId}
      canRegenerate={Boolean(props.m.id) && !props.busy}
      onRegenerate={(id) => props.onRegenerate(props.m.key, id)}
      onOpenArtifact={props.onOpenArtifact}
    />
  )
})
