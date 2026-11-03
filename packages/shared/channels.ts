/**
 * IPC channel and event names. Dependency-free so the sandboxed preload can bundle it.
 */

/** `ipcMain.handle` channel for an API method: `crosspoint:<area>:<method>` (nested areas joined with '.'). */
export const channel = <A extends string, M extends string>(area: A, method: M): `crosspoint:${A}:${M}` =>
  `crosspoint:${area}:${method}`

export const Channels = {
  app: { version: channel('app', 'version'), openExternal: channel('app', 'openExternal'), openPath: channel('app', 'openPath') },
  pairing: {
    status: channel('pairing', 'status'),
    pair: channel('pairing', 'pair'),
    unpair: channel('pairing', 'unpair'),
    syncNow: channel('pairing', 'syncNow')
  },
  config: { get: channel('config', 'get') },
  models: {
    list: channel('models', 'list'),
    refresh: channel('models', 'refresh'),
    setTags: channel('models', 'setTags'),
    tagsList: channel('models.tags', 'list'),
    tagsSave: channel('models.tags', 'save'),
    tagsRemove: channel('models.tags', 'remove')
  },
  chat: { send: channel('chat', 'send'), stop: channel('chat', 'stop'), regenerate: channel('chat', 'regenerate') },
  conversations: {
    list: channel('conversations', 'list'),
    get: channel('conversations', 'get'),
    create: channel('conversations', 'create'),
    update: channel('conversations', 'update'),
    remove: channel('conversations', 'remove')
  },
  projects: {
    list: channel('projects', 'list'),
    create: channel('projects', 'create'),
    update: channel('projects', 'update'),
    remove: channel('projects', 'remove'),
    filesList: channel('projects.files', 'list'),
    filesAdd: channel('projects.files', 'add'),
    filesRemove: channel('projects.files', 'remove')
  },
  attachments: { pick: channel('attachments', 'pick'), fromPaste: channel('attachments', 'fromPaste') },
  artifacts: {
    list: channel('artifacts', 'list'),
    listAll: channel('artifacts', 'listAll'),
    get: channel('artifacts', 'get'),
    save: channel('artifacts', 'save'),
    exportTo: channel('artifacts', 'exportTo')
  },
  memories: { list: channel('memories', 'list'), add: channel('memories', 'add'), remove: channel('memories', 'remove') },
  usage: { summary: channel('usage', 'summary'), forMessage: channel('usage', 'forMessage') },
  settings: { get: channel('settings', 'get'), set: channel('settings', 'set') },
  health: { check: channel('health', 'check') },
  audit: { list: channel('audit', 'list') },
  updates: { check: channel('updates', 'check'), install: channel('updates', 'install') }
} as const

/** Main -> renderer push events: `crosspoint:event:<name>`. */
export const Events = {
  pairingStatus: 'crosspoint:event:pairing-status',
  configChange: 'crosspoint:event:config-change',
  chat: 'crosspoint:event:chat'
} as const

/**
 * Artifact previews are served by main from this privileged scheme so inline scripts run inside a
 * sandboxed iframe (opaque origin, no preload, no IPC) under their own CSP, not the app's.
 */
export const ARTIFACT_PROTOCOL = 'crosspoint-artifact'

/** Preview URL for an artifact version; the version in the query busts caches after an edit. */
export const artifactPreviewUrl = (id: string, version: number): string =>
  `${ARTIFACT_PROTOCOL}://preview/${encodeURIComponent(id)}?v=${version}`
