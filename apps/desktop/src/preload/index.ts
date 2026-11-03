import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
// Only the dependency-free channel table is bundled; the sandboxed preload cannot load node_modules.
import { Channels as C, Events } from '@shared/channels'
import type { AppConfig, CrosspointApi, PairingStatus, StreamEvent } from '@shared/ipc'

const invoke = (channel: string, ...args: unknown[]): Promise<never> => ipcRenderer.invoke(channel, ...args) as Promise<never>

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(event, listener)
  return () => {
    ipcRenderer.removeListener(event, listener)
  }
}

const api: CrosspointApi = {
  app: {
    version: () => invoke(C.app.version),
    openExternal: (url) => invoke(C.app.openExternal, url),
    openPath: (p) => invoke(C.app.openPath, p)
  },
  pairing: {
    status: () => invoke(C.pairing.status),
    pair: (code, host) => invoke(C.pairing.pair, code, host),
    unpair: () => invoke(C.pairing.unpair),
    syncNow: () => invoke(C.pairing.syncNow),
    onStatus: (cb) => subscribe<PairingStatus>(Events.pairingStatus, cb)
  },
  config: {
    get: () => invoke(C.config.get),
    onChange: (cb) => subscribe<AppConfig>(Events.configChange, cb)
  },
  models: {
    list: () => invoke(C.models.list),
    refresh: () => invoke(C.models.refresh),
    setTags: (modelId, tags) => invoke(C.models.setTags, modelId, tags),
    tags: {
      list: () => invoke(C.models.tagsList),
      save: (t) => invoke(C.models.tagsSave, t),
      remove: (id) => invoke(C.models.tagsRemove, id)
    }
  },
  chat: {
    send: (input) => invoke(C.chat.send, input),
    stop: (runId) => invoke(C.chat.stop, runId),
    regenerate: (messageId, modelId) => invoke(C.chat.regenerate, messageId, modelId),
    onEvent: (cb) => subscribe<StreamEvent>(Events.chat, cb)
  },
  conversations: {
    list: (q) => invoke(C.conversations.list, q),
    get: (id) => invoke(C.conversations.get, id),
    create: (input) => invoke(C.conversations.create, input),
    update: (id, patch) => invoke(C.conversations.update, id, patch),
    remove: (id) => invoke(C.conversations.remove, id)
  },
  projects: {
    list: () => invoke(C.projects.list),
    create: (p) => invoke(C.projects.create, p),
    update: (id, patch) => invoke(C.projects.update, id, patch),
    remove: (id) => invoke(C.projects.remove, id),
    files: {
      list: (projectId) => invoke(C.projects.filesList, projectId),
      add: (projectId) => invoke(C.projects.filesAdd, projectId),
      remove: (id) => invoke(C.projects.filesRemove, id)
    }
  },
  attachments: {
    pick: () => invoke(C.attachments.pick),
    fromPaste: (data) => invoke(C.attachments.fromPaste, data)
  },
  artifacts: {
    list: (conversationId) => invoke(C.artifacts.list, conversationId),
    get: (id) => invoke(C.artifacts.get, id),
    save: (id, content) => invoke(C.artifacts.save, id, content),
    exportTo: (id) => invoke(C.artifacts.exportTo, id)
  },
  memories: {
    list: () => invoke(C.memories.list),
    add: (text) => invoke(C.memories.add, text),
    remove: (id) => invoke(C.memories.remove, id)
  },
  usage: {
    summary: () => invoke(C.usage.summary),
    forMessage: (messageId) => invoke(C.usage.forMessage, messageId)
  },
  settings: {
    get: () => invoke(C.settings.get),
    set: (patch) => invoke(C.settings.set, patch)
  },
  health: { check: () => invoke(C.health.check) },
  audit: { list: (q) => invoke(C.audit.list, q) },
  updates: {
    check: () => invoke(C.updates.check),
    install: () => invoke(C.updates.install)
  }
}

contextBridge.exposeInMainWorld('crosspoint', api)
