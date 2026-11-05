import { create } from 'zustand'
import { api, errorText } from '../lib/api'
import { uid } from '../lib/utils'
import type {
  AttachmentRef,
  ChatSettings,
  Conversation,
  ConversationSummary,
  Message,
  StreamEvent,
  UsageInfo,
} from '../lib/types'
import { useApp } from './app'

export interface UINotice {
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface UITool {
  id: string
  name: string
  input?: unknown
  output?: unknown
  isError?: boolean
  done: boolean
}

export interface UIMessage {
  /** Stable React key; equals the server id for loaded messages. */
  key: string
  id?: string
  role: Message['role']
  content: string
  thinking?: string
  thinkingMs?: number
  modelId?: string
  provider?: string
  attachments: AttachmentRef[]
  usage?: UsageInfo
  error?: string
  stopped?: boolean
  notices: UINotice[]
  tools: UITool[]
  streaming: boolean
  runId?: string
  createdAt: string
  /** When the thinking stream started, to show "Thought for N s". */
  thinkingStartedAt?: number
}

interface RunInfo {
  conversationId: string
  key: string
}

interface Draft {
  projectId?: string
  modelId?: string
  settings?: ChatSettings
}

interface ChatState {
  conversations: ConversationSummary[]
  listLoaded: boolean
  listError: string | null
  currentId: string | null
  conversation: Conversation | null
  messages: UIMessage[]
  loading: boolean
  loadError: string | null
  draft: Draft
  runs: Record<string, RunInfo>
  /** Placeholder assistant message waiting for chat.send to return its runId. */
  pendingKey: string | null
  /** Bumped when a run finishes so artifact lists refetch. */
  artifactsVersion: number

  init(): () => void
  loadList(): Promise<void>
  /** Picks up changes from another PC in the open chat. */
  reload(): Promise<void>
  open(id: string): Promise<void>
  newChat(projectId?: string): void
  send(text: string, attachments: AttachmentRef[]): Promise<void>
  stop(): Promise<void>
  regenerate(key: string, modelId?: string): Promise<void>
  setModel(modelId: string | undefined): Promise<void>
  updateSettings(patch: Partial<ChatSettings>): Promise<void>
  rename(id: string, title: string): Promise<void>
  setPinned(id: string, pinned: boolean): Promise<void>
  archive(id: string): Promise<void>
  moveToProject(id: string, projectId: string | null): Promise<void>
  remove(id: string): Promise<void>
  handleEvent(e: StreamEvent): void
}

/** Flattens a stored message's parts into what the thread renders. */
export function fromServer(m: Message): UIMessage {
  const text: string[] = []
  const thinking: string[] = []
  const attachments: AttachmentRef[] = []
  const tools: UITool[] = []
  const notices: UINotice[] = []
  for (const p of m.parts) {
    switch (p.type) {
      case 'text':
        text.push(p.text)
        break
      case 'thinking':
        thinking.push(p.text)
        break
      case 'attachment':
        attachments.push(p.attachment)
        break
      case 'tool_call':
        tools.push({ id: p.id, name: p.name, input: p.input, done: false })
        break
      case 'tool_result': {
        const t = tools.find((x) => x.id === p.id)
        if (t) Object.assign(t, { output: p.output, isError: p.isError, done: true })
        break
      }
      case 'notice':
        notices.push({ level: p.level, text: p.message })
        break
    }
  }
  const errorNotice = m.status === 'error' ? notices.find((n) => n.level === 'error') : undefined
  return {
    key: m.id,
    id: m.id,
    role: m.role,
    content: text.join(''),
    thinking: thinking.length ? thinking.join('') : undefined,
    modelId: m.modelId ?? undefined,
    provider: m.provider ?? undefined,
    attachments,
    usage: m.usage ?? undefined,
    error: m.status === 'error' ? (errorNotice?.text ?? 'This answer failed.') : undefined,
    stopped: m.status === 'stopped',
    notices: errorNotice ? notices.filter((n) => n !== errorNotice) : notices,
    tools,
    streaming: m.status === 'streaming',
    createdAt: m.createdAt,
  }
}

function blankAssistant(key: string, modelId?: string): UIMessage {
  return {
    key,
    role: 'assistant',
    content: '',
    modelId,
    attachments: [],
    notices: [],
    tools: [],
    streaming: true,
    createdAt: new Date().toISOString(),
  }
}

function toast(text: string): void {
  useApp.getState().toast(text, 'error')
}

export const useChat = create<ChatState>((set, get) => {
  function patchMessage(key: string, fn: (m: UIMessage) => UIMessage): void {
    set((s) => ({ messages: s.messages.map((m) => (m.key === key ? fn(m) : m)) }))
  }

  /** Replaces optimistic messages with the stored ones once no run is active in this chat. */
  async function reloadCurrent(): Promise<void> {
    const id = get().currentId
    if (!id) return
    try {
      const { conversation, messages } = await api.conversations.get(id)
      if (get().currentId !== id) return
      if (Object.values(get().runs).some((r) => r.conversationId === id)) return
      const prev = new Map(get().messages.filter((m) => m.id).map((m) => [m.id as string, m]))
      const merged = messages
        .filter((m) => m.role !== 'system')
        .map(fromServer)
        .map((m) => {
          const p = m.id ? prev.get(m.id) : undefined
          return p?.thinkingMs != null ? { ...m, thinkingMs: p.thinkingMs } : m
        })
      set({ conversation, messages: merged })
    } catch {
      /* keep what is on screen */
    }
  }

  return {
    conversations: [],
    listLoaded: false,
    listError: null,
    currentId: null,
    conversation: null,
    messages: [],
    loading: false,
    loadError: null,
    draft: {},
    runs: {},
    pendingKey: null,
    artifactsVersion: 0,

    init() {
      void get().loadList()
      return api.chat.onEvent((e) => get().handleEvent(e))
    },

    reload: reloadCurrent,

    async loadList() {
      try {
        const conversations = await api.conversations.list({ limit: 500 })
        set({ conversations, listLoaded: true, listError: null })
      } catch (err) {
        set({ listLoaded: true, listError: errorText(err) })
      }
    },

    async open(id) {
      useApp.getState().go('chat')
      if (get().currentId === id && get().conversation) return
      set({ currentId: id, loading: true, loadError: null, messages: [], conversation: null })
      try {
        const { conversation, messages } = await api.conversations.get(id)
        if (get().currentId !== id) return
        set({
          conversation,
          messages: messages.filter((m) => m.role !== 'system').map(fromServer),
          loading: false,
        })
      } catch (err) {
        if (get().currentId === id) set({ loading: false, loadError: errorText(err) })
      }
    },

    newChat(projectId) {
      useApp.getState().go('chat')
      set({
        currentId: null,
        conversation: null,
        messages: [],
        loadError: null,
        loading: false,
        draft: { projectId, modelId: get().draft.modelId, settings: get().draft.settings },
      })
    },

    async send(text, attachments) {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return
      let conv = get().conversation
      const { draft } = get()
      if (!conv) {
        try {
          conv = await api.conversations.create({ projectId: draft.projectId, modelId: draft.modelId })
          if (draft.settings) {
            await api.conversations.update(conv.id, { settings: draft.settings })
            conv = { ...conv, settings: draft.settings }
          }
          set({ currentId: conv.id, conversation: conv })
          void get().loadList()
        } catch (err) {
          toast(`Could not start a chat: ${errorText(err)}`)
          return
        }
      }
      const c: Conversation = conv
      const userKey = uid('u')
      const asstKey = uid('a')
      set((s) => ({
        pendingKey: asstKey,
        messages: [
          ...s.messages,
          {
            key: userKey,
            role: 'user',
            content: trimmed,
            attachments,
            notices: [],
            tools: [],
            streaming: false,
            createdAt: new Date().toISOString(),
          },
          blankAssistant(asstKey, c.modelId ?? undefined),
        ],
      }))
      try {
        const res = await api.chat.send({
          conversationId: c.id,
          text: trimmed,
          attachments: attachments.length ? attachments : undefined,
          modelId: c.modelId ?? undefined,
          settings: c.settings,
        })
        const already = Object.values(get().runs).some((r) => r.key === asstKey)
        set((s) => ({
          runs: already ? s.runs : { ...s.runs, [res.runId]: { conversationId: c.id, key: asstKey } },
          pendingKey: s.pendingKey === asstKey ? null : s.pendingKey,
        }))
        patchMessage(asstKey, (m) => ({ ...m, runId: res.runId }))
      } catch (err) {
        set((s) => ({ pendingKey: s.pendingKey === asstKey ? null : s.pendingKey }))
        patchMessage(asstKey, (m) => ({ ...m, streaming: false, error: errorText(err) }))
      }
    },

    async stop() {
      const { runs, currentId, pendingKey } = get()
      const entries = Object.entries(runs).filter(([, r]) => r.conversationId === currentId)
      if (entries.length === 0 && pendingKey) {
        patchMessage(pendingKey, (m) => ({ ...m, streaming: false, stopped: true }))
        return
      }
      await Promise.all(
        entries.map(async ([runId]) => {
          try {
            await api.chat.stop(runId)
          } catch (err) {
            toast(`Could not stop: ${errorText(err)}`)
          }
        }),
      )
    },

    async regenerate(key, modelId) {
      const msg = get().messages.find((m) => m.key === key)
      if (!msg?.id) return
      const conv = get().conversation
      patchMessage(key, (m) => ({
        ...m,
        content: '',
        thinking: undefined,
        thinkingMs: undefined,
        thinkingStartedAt: undefined,
        error: undefined,
        stopped: false,
        usage: undefined,
        notices: [],
        tools: [],
        streaming: true,
        modelId: modelId ?? m.modelId,
      }))
      set({ pendingKey: key })
      try {
        const { runId } = await api.chat.regenerate(msg.id, modelId)
        set((s) => ({
          runs: s.runs[runId] ? s.runs : { ...s.runs, [runId]: { conversationId: conv?.id ?? '', key } },
          pendingKey: s.pendingKey === key ? null : s.pendingKey,
        }))
        patchMessage(key, (m) => ({ ...m, runId }))
      } catch (err) {
        set((s) => ({ pendingKey: s.pendingKey === key ? null : s.pendingKey }))
        patchMessage(key, (m) => ({ ...m, streaming: false, error: errorText(err) }))
      }
    },

    async setModel(modelId) {
      const conv = get().conversation
      if (!conv) {
        set((s) => ({ draft: { ...s.draft, modelId } }))
        return
      }
      set({ conversation: { ...conv, modelId: modelId ?? null } })
      try {
        await api.conversations.update(conv.id, { modelId: modelId ?? null })
      } catch (err) {
        set({ conversation: conv })
        toast(`Could not change model: ${errorText(err)}`)
      }
    },

    async updateSettings(patch) {
      const conv = get().conversation
      if (!conv) {
        set((s) => ({ draft: { ...s.draft, settings: { ...s.draft.settings, ...patch } } }))
        return
      }
      const settings: ChatSettings = { ...conv.settings, ...patch }
      set({ conversation: { ...conv, settings } })
      try {
        await api.conversations.update(conv.id, { settings })
      } catch (err) {
        set({ conversation: conv })
        toast(`Could not save chat settings: ${errorText(err)}`)
      }
    },

    async rename(id, title) {
      const t = title.trim()
      if (!t) return
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: t } : c)),
        conversation: s.conversation?.id === id ? { ...s.conversation, title: t } : s.conversation,
      }))
      try {
        await api.conversations.update(id, { title: t })
      } catch (err) {
        toast(`Could not rename: ${errorText(err)}`)
        void get().loadList()
      }
    },

    async setPinned(id, pinned) {
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, pinned } : c)) }))
      try {
        await api.conversations.update(id, { pinned })
      } catch (err) {
        toast(`Could not ${pinned ? 'pin' : 'unpin'}: ${errorText(err)}`)
        void get().loadList()
      }
    },

    async archive(id) {
      try {
        await api.conversations.update(id, { archived: true })
        if (get().currentId === id) get().newChat()
        void get().loadList()
      } catch (err) {
        toast(`Could not archive: ${errorText(err)}`)
      }
    },

    async moveToProject(id, projectId) {
      try {
        await api.conversations.update(id, { projectId })
        set((s) => ({
          conversation: s.conversation?.id === id ? { ...s.conversation, projectId } : s.conversation,
        }))
        void get().loadList()
      } catch (err) {
        toast(`Could not move chat: ${errorText(err)}`)
      }
    },

    async remove(id) {
      try {
        await api.conversations.remove(id)
        if (get().currentId === id) get().newChat()
        set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) }))
      } catch (err) {
        toast(`Could not delete: ${errorText(err)}`)
      }
    },

    handleEvent(e) {
      const state = get()
      const known = state.runs[e.runId]
      const conversationId = known?.conversationId || e.conversationId

      if (conversationId !== state.currentId) {
        if (e.type === 'done') {
          set((s) => {
            const runs = { ...s.runs }
            delete runs[e.runId]
            return { runs }
          })
          void get().loadList()
          void useApp.getState().refreshUsage()
        }
        return
      }

      let key = known?.key
      if (!key && state.pendingKey) {
        key = state.pendingKey
        const k0 = key
        set((s) => ({ runs: { ...s.runs, [e.runId]: { conversationId, key: k0 } }, pendingKey: null }))
      }
      if (!key || !get().messages.some((m) => m.key === key)) {
        // A run this window did not start (or a chat reopened mid-stream): show it as a new reply.
        if (e.type === 'done') {
          void reloadCurrent()
          return
        }
        const k1 = key ?? uid('a')
        key = k1
        set((s) => ({
          messages: [...s.messages, { ...blankAssistant(k1), runId: e.runId, id: e.messageId }],
          runs: { ...s.runs, [e.runId]: { conversationId, key: k1 } },
        }))
      }
      const k = key

      switch (e.type) {
        case 'text':
          patchMessage(k, (m) => ({
            ...m,
            content: m.content + e.delta,
            thinkingMs: m.thinkingStartedAt && m.thinkingMs == null ? Date.now() - m.thinkingStartedAt : m.thinkingMs,
            id: e.messageId || m.id,
          }))
          break
        case 'thinking':
          patchMessage(k, (m) => ({
            ...m,
            thinking: (m.thinking ?? '') + e.delta,
            thinkingStartedAt: m.thinkingStartedAt ?? Date.now(),
            id: e.messageId || m.id,
          }))
          break
        case 'tool_call':
          patchMessage(k, (m) => ({ ...m, tools: [...m.tools, { id: e.id, name: e.name, input: e.input, done: false }] }))
          break
        case 'tool_result':
          patchMessage(k, (m) => ({
            ...m,
            tools: m.tools.map((t) => (t.id === e.id ? { ...t, output: e.output, isError: e.isError, done: true } : t)),
          }))
          break
        case 'attachment':
          patchMessage(k, (m) => ({ ...m, attachments: [...m.attachments, e.attachment], id: e.messageId || m.id }))
          break
        case 'usage':
          patchMessage(k, (m) => ({ ...m, usage: e.usage, modelId: e.usage.model || m.modelId, provider: e.usage.provider }))
          break
        case 'notice':
          patchMessage(k, (m) => ({ ...m, notices: [...m.notices, { level: e.level, text: e.message }] }))
          break
        case 'error':
          patchMessage(k, (m) => ({ ...m, error: e.message || 'The run failed.' }))
          break
        case 'done': {
          patchMessage(k, (m) => ({
            ...m,
            streaming: false,
            stopped: e.finishReason === 'stopped',
            id: e.messageId || m.id,
            notices:
              e.finishReason === 'length'
                ? [...m.notices, { level: 'warn', text: 'The answer hit the output limit and was cut off.' }]
                : e.finishReason === 'refusal'
                  ? [...m.notices, { level: 'warn', text: 'The model declined to answer.' }]
                  : m.notices,
          }))
          set((s) => {
            const runs = { ...s.runs }
            delete runs[e.runId]
            const title = e.title
            return {
              runs,
              artifactsVersion: s.artifactsVersion + 1,
              conversation: title && s.conversation?.id === conversationId ? { ...s.conversation, title } : s.conversation,
            }
          })
          void reloadCurrent()
          void get().loadList()
          void useApp.getState().refreshUsage()
          break
        }
      }
    },
  }
})

export function isStreaming(s: Pick<ChatState, 'messages'>): boolean {
  return s.messages.some((m) => m.streaming)
}
