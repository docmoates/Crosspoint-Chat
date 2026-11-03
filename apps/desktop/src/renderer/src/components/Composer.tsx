import * as DM from '@radix-ui/react-dropdown-menu'
import {
  ArrowUp,
  Brain,
  Camera,
  Code2,
  FileText,
  FolderClosed,
  Globe,
  Image as ImageIcon,
  Lock,
  Mic,
  Monitor,
  Paperclip,
  PanelRight,
  Plug,
  Plus,
  Square,
  Wand2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { api, errorText } from '../lib/api'
import { bytes, fileToBase64 } from '../lib/utils'
import type { AttachmentRef } from '../lib/types'
import { useApp } from '../store/app'
import { useConfig } from '../store/config'
import { usePairing } from '../store/pairing'
import { isStreaming, useChat } from '../store/chat'
import { ChatSettingsPopover } from './ChatSettingsPopover'
import { ModelPicker } from './ModelPicker'
import { Soon, Switch } from './ui/primitives'

function SoonItem(props: { icon: ReactElement; label: string }): ReactElement {
  return (
    <DM.Item className="menu-item" disabled>
      {props.icon} {props.label}
      <Soon className="ml-auto" />
    </DM.Item>
  )
}

export function Composer(): ReactElement {
  const conversation = useChat((s) => s.conversation)
  const currentId = useChat((s) => s.currentId)
  const draft = useChat((s) => s.draft)
  const streaming = useChat(isStreaming)
  const { send, stop, setModel, updateSettings } = useChat.getState()
  const sendOnEnter = useApp((s) => s.settings.sendOnEnter)
  const toast = useApp((s) => s.toast)
  const models = useConfig((s) => s.models)
  const config = useConfig((s) => s.config)
  const host = usePairing((s) => s.status?.host)

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  const [uploading, setUploading] = useState(0)
  const [drag, setDrag] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  const modelId = (conversation ? conversation.modelId : draft.modelId) ?? undefined
  const settings = conversation ? conversation.settings : draft.settings
  const projectId = conversation ? (conversation.projectId ?? undefined) : draft.projectId
  const model = models.find((m) => m.id === modelId)

  useEffect(() => {
    ta.current?.focus()
  }, [currentId])

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    setUploading((n) => n + files.length)
    for (const f of files) {
      try {
        const ref = await api.attachments.fromPaste({
          name: f.name || `pasted-${Date.now()}.${(f.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg')}`,
          mime: f.type || 'application/octet-stream',
          base64: await fileToBase64(f),
        })
        setAttachments((a) => [...a, ref])
      } catch (err) {
        toast(`Could not attach ${f.name || 'file'}: ${errorText(err)}`, 'error')
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const pick = async (): Promise<void> => {
    try {
      const refs = await api.attachments.pick()
      if (refs.length) setAttachments((a) => [...a, ...refs])
    } catch (err) {
      toast(`Could not attach files: ${errorText(err)}`, 'error')
    }
  }

  const submit = (): void => {
    if (streaming || uploading > 0) return
    if (!text.trim() && attachments.length === 0) return
    const t = text
    const a = attachments
    setText('')
    setAttachments([])
    void send(t, a)
  }

  const canSend = !streaming && uploading === 0 && (text.trim().length > 0 || attachments.length > 0)
  const mcp = config?.mcp_servers ?? []

  return (
    <div className="composer-wrap">
      <div
        className={drag ? 'composer drag' : 'composer'}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDrag(true)
          }
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          void addFiles([...e.dataTransfer.files])
        }}
      >
        {(attachments.length > 0 || uploading > 0) && (
          <div className="chips">
            {attachments.map((a) => (
              <span key={a.id} className="attach">
                {a.kind === 'image' ? <ImageIcon className="ic-sm" /> : <FileText className="ic-sm" />}
                {a.name}
                <span className="faint">· {bytes(a.size)}</span>
                <button
                  type="button"
                  className="faint"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}
                >
                  <X className="ic-xs" />
                </button>
              </span>
            ))}
            {uploading > 0 && <span className="attach faint">Attaching {uploading}…</span>}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder="Message Crosspoint…"
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            const wantsSend = sendOnEnter ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey
            if (wantsSend) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="row">
          <DM.Root>
            <DM.Trigger asChild>
              <button type="button" className="iconbtn" title="Add files, tools and connectors">
                <Plus />
              </button>
            </DM.Trigger>
            <DM.Portal>
              <DM.Content className="menu" side="top" align="start" sideOffset={6} style={{ minWidth: 300 }}>
                <div className="eyebrow">Add</div>
                <DM.Item className="menu-item" onSelect={() => void pick()}>
                  <Paperclip className="ic-sm" /> Upload files or images
                </DM.Item>
                <DM.Item
                  className="menu-item"
                  disabled={!projectId}
                  onSelect={() => {
                    if (projectId)
                      void api.projects.files
                        .add(projectId)
                        .then((f) => f.length && toast(`Added ${f.length} file${f.length === 1 ? '' : 's'} to the project`))
                        .catch((err) => toast(errorText(err), 'error'))
                  }}
                >
                  <FolderClosed className="ic-sm" /> Add project knowledge
                  {!projectId && <span className="right">chat is not in a project</span>}
                </DM.Item>
                <SoonItem icon={<Camera className="ic-sm" />} label="Take photo" />
                <SoonItem icon={<FolderClosed className="ic-sm" />} label="Add from GitHub or Drive" />
                <div className="eyebrow">Create</div>
                <SoonItem icon={<ImageIcon className="ic-sm" />} label="Generate image" />
                <SoonItem icon={<PanelRight className="ic-sm" />} label="New artifact / document" />
                <div className="eyebrow">Tools</div>
                <SoonItem icon={<Globe className="ic-sm" />} label="Web search" />
                <SoonItem icon={<Code2 className="ic-sm" />} label="Code interpreter" />
                <SoonItem icon={<Brain className="ic-sm" />} label="Deep research" />
                <SoonItem icon={<Monitor className="ic-sm" />} label="Computer use" />
                <div className="eyebrow flex items-center gap-2">
                  Connectors (MCP) <Soon />
                </div>
                {mcp.length === 0 ? (
                  <DM.Item className="menu-item" disabled>
                    <Plug className="ic-sm" /> No MCP servers set up in admin
                  </DM.Item>
                ) : (
                  mcp.map((s) => (
                    <DM.Item key={s.id} className="menu-item" disabled>
                      <Plug className="ic-sm" /> {s.name}
                      <span className="sub">{s.transport}</span>
                      <span className="ml-auto">
                        <Switch label={s.name} checked={false} disabled />
                      </span>
                    </DM.Item>
                  ))
                )}
                <div className="eyebrow flex items-center gap-2">
                  Skills <Soon />
                </div>
                <DM.Item className="menu-item" disabled>
                  <Wand2 className="ic-sm" /> Slash-command skills are planned
                </DM.Item>
              </DM.Content>
            </DM.Portal>
          </DM.Root>
          <ModelPicker value={modelId} onChange={(id) => void setModel(id)} settings={settings} onSettings={(p) => void updateSettings(p)} />
          <ChatSettingsPopover
            settings={settings}
            onChange={(p) => void updateSettings(p)}
            supportsThinking={model ? model.capabilities.reasoning : true}
          />
          <button type="button" className="pill desk-only" disabled title="Private mode needs local models (coming soon)">
            <Lock className="ic-xs" /> Private
          </button>
          <span className="grow" />
          <button type="button" className="iconbtn" disabled title="Voice (coming soon)">
            <Mic />
          </button>
          {streaming ? (
            <button type="button" className="send" title="Stop (Esc)" onClick={() => void stop()}>
              <Square className="ic-sm" fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send" title="Send" disabled={!canSend} onClick={submit}>
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
      <div className="hint desk-only">
        {sendOnEnter ? 'Enter to send · Shift+Enter for a new line' : 'Ctrl+Enter to send · Enter for a new line'} · Esc stops ·
        Keys and limits managed in {(host ?? 'admin.docmoates.com').replace(/^https?:\/\//, '')}
      </div>
    </div>
  )
}
