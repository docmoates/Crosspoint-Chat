import { BrowserWindow, dialog, ipcMain, shell, app, type IpcMainInvokeEvent } from 'electron'
import { writeFileSync } from 'node:fs'
import { relative, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  ArtifactListAllLimitSchema,
  AuditListQuerySchema,
  Channels,
  ChatSendInputSchema,
  ConversationCreateInputSchema,
  ConversationListQuerySchema,
  ConversationPatchSchema,
  IdSchema,
  LocalSettingsPatchSchema,
  PasteDataSchema,
  ProjectCreateSchema,
  ProjectPatchSchema,
  TagSchema,
  UrlSchema
} from '@shared/ipc'
import type { Core } from './core'
import { checkHealth } from './services/health'

type Handler = (...args: never[]) => unknown

/**
 * Registers `ipcMain.handle(channel)` with zod validation of every argument.
 * Requests from anything other than our own renderer are rejected.
 */
function handle<S extends z.ZodTuple>(channelName: string, args: S, fn: (...a: z.infer<S>) => unknown, isTrusted: (e: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(channelName, async (event, ...raw: unknown[]) => {
    if (!isTrusted(event)) throw new Error('Untrusted sender')
    const parsed = args.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(`Invalid arguments for ${channelName}: ${issue?.path.join('.') || 'input'} ${issue?.message ?? ''}`.trim())
    }
    return (fn as Handler)(...(parsed.data as never[]))
  })
}

export function registerIpc(core: Core, opts: { isTrustedUrl: (url: string) => boolean; afterPair: () => void }): void {
  const trusted = (e: IpcMainInvokeEvent): boolean => opts.isTrustedUrl(e.senderFrame?.url ?? '')
  const h = <S extends z.ZodTuple>(c: string, s: S, fn: (...a: z.infer<S>) => unknown): void => handle(c, s, fn, trusted)
  const none = z.tuple([])
  const id = z.tuple([IdSchema])
  const win = (e?: IpcMainInvokeEvent): BrowserWindow | undefined =>
    (e && BrowserWindow.fromWebContents(e.sender)) || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]

  // app
  h(Channels.app.version, none, () => app.getVersion())
  h(Channels.app.openExternal, z.tuple([UrlSchema]), async (url) => {
    await shell.openExternal(url)
  })
  h(Channels.app.openPath, z.tuple([z.string().min(1).max(1000)]), async (p) => {
    // Only paths inside the data folder (attachments, exports); never arbitrary executables.
    const target = resolve(p)
    const rel = relative(core.paths.root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Only files inside the Crosspoint data folder can be opened.')
    const err = await shell.openPath(target)
    if (err) throw new Error(err)
  })

  // pairing
  h(Channels.pairing.status, none, () => core.sync.status())
  h(Channels.pairing.pair, z.tuple([z.string().max(64), z.string().max(255).optional()]), async (code, host) => {
    const res = await core.pairing.pair(code, host)
    if (res.ok) {
      core.audit.append('sync', `paired as device ${core.pairing.device?.deviceId} with ${core.pairing.host}`)
      opts.afterPair()
      await core.sync.onPaired()
    }
    return res
  })
  h(Channels.pairing.unpair, none, () => {
    core.chat.stopAll()
    core.audit.append('sync', 'unpaired by user; local keys wiped')
    core.sync.wipe()
  })
  h(Channels.pairing.syncNow, none, () => core.sync.syncNow())

  // config
  h(Channels.config.get, none, () => core.sync.sanitized())

  // models
  h(Channels.models.list, none, () => core.catalog.list())
  h(Channels.models.refresh, none, () => core.catalog.refresh(true))
  h(Channels.models.setTags, z.tuple([IdSchema, z.array(IdSchema).max(100)]), (modelId, tags) => core.catalog.setTags(modelId, tags))
  h(Channels.models.tagsList, none, () => core.catalog.listTags())
  h(Channels.models.tagsSave, z.tuple([TagSchema]), (t) => core.catalog.saveTag(t))
  h(Channels.models.tagsRemove, id, (tagId) => core.catalog.removeTag(tagId))

  // chat
  h(Channels.chat.send, z.tuple([ChatSendInputSchema]), (input) => core.chat.send(input))
  h(Channels.chat.stop, id, (runId) => core.chat.stop(runId))
  h(Channels.chat.regenerate, z.tuple([IdSchema, IdSchema.optional()]), (messageId, modelId) => core.chat.regenerate(messageId, modelId))

  // conversations
  h(Channels.conversations.list, z.tuple([ConversationListQuerySchema]), (q) => core.library.listConversations(q))
  h(Channels.conversations.get, id, (cid) => ({ conversation: core.library.getConversation(cid), messages: core.library.listMessages(cid) }))
  h(Channels.conversations.create, z.tuple([ConversationCreateInputSchema]), (input) => core.library.createConversation(input))
  h(Channels.conversations.update, z.tuple([IdSchema, ConversationPatchSchema]), (cid, patch) => core.library.updateConversation(cid, patch))
  h(Channels.conversations.remove, id, (cid) => {
    const paths = core.library.removeConversation(cid)
    core.files.removeFiles(paths)
  })

  // projects
  h(Channels.projects.list, none, () => core.library.listProjects())
  h(Channels.projects.create, z.tuple([ProjectCreateSchema]), (p) => core.library.createProject(p))
  h(Channels.projects.update, z.tuple([IdSchema, ProjectPatchSchema]), (pid, patch) => core.library.updateProject(pid, patch))
  h(Channels.projects.remove, id, (pid) => core.files.removeFiles(core.library.removeProject(pid)))
  h(Channels.projects.filesList, id, (pid) => core.files.listProjectFiles(pid))
  h(Channels.projects.filesAdd, id, async (pid) => {
    core.library.getProject(pid)
    const w = win()
    const pick = await (w
      ? dialog.showOpenDialog(w, { title: 'Add project files', properties: ['openFile', 'multiSelections'] })
      : dialog.showOpenDialog({ title: 'Add project files', properties: ['openFile', 'multiSelections'] }))
    if (pick.canceled) return []
    const out = []
    for (const p of pick.filePaths) out.push(await core.files.addProjectFile(pid, p))
    return out
  })
  h(Channels.projects.filesRemove, id, (fid) => core.files.removeProjectFile(fid))

  // attachments
  h(Channels.attachments.pick, none, async () => {
    const w = win()
    const options: Electron.OpenDialogOptions = {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx', 'py', 'sql', 'log'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const pick = await (w ? dialog.showOpenDialog(w, options) : dialog.showOpenDialog(options))
    if (pick.canceled) return []
    const out = []
    for (const p of pick.filePaths) out.push(await core.files.addAttachmentFromPath(p))
    return out
  })
  h(Channels.attachments.fromPaste, z.tuple([PasteDataSchema]), (data) => core.files.addAttachmentFromPaste(data))

  // artifacts
  h(Channels.artifacts.list, id, (cid) => core.artifacts.list(cid))
  h(Channels.artifacts.listAll, z.tuple([ArtifactListAllLimitSchema]), (limit) => core.artifacts.listAll(limit))
  h(Channels.artifacts.get, id, (aid) => core.artifacts.get(aid))
  h(Channels.artifacts.save, z.tuple([IdSchema, z.string().max(5_000_000)]), (aid, content) => core.artifacts.save(aid, content))
  h(Channels.artifacts.exportTo, id, async (aid) => {
    const a = core.artifacts.get(aid)
    const ext = core.artifacts.extension(a.kind, a.language)
    const safe = a.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'artifact'
    const w = win()
    const options: Electron.SaveDialogOptions = { title: 'Export artifact', defaultPath: `${safe}.${ext}` }
    const res = await (w ? dialog.showSaveDialog(w, options) : dialog.showSaveDialog(options))
    if (res.canceled || !res.filePath) return
    writeFileSync(res.filePath, a.content, 'utf8')
  })

  // memories
  h(Channels.memories.list, none, () => core.library.listMemories())
  h(Channels.memories.add, z.tuple([z.string().trim().min(1).max(5_000)]), (text) => core.library.addMemory(text))
  h(Channels.memories.remove, id, (mid) => core.library.removeMemory(mid))

  // usage
  h(Channels.usage.summary, none, () => core.usage.summary())
  h(Channels.usage.forMessage, id, (mid) => {
    const d = core.usage.forMessage(mid)
    if (!d) return null
    const models = core.catalog.cachedList()
    const m =
      models.find((x) => x.id === d.model) ??
      models.find((x) => x.provider === d.provider && (x.id === `${d.provider}:${d.model}` || x.id.endsWith(`/${d.model}`)))
    return { ...d, pricing: m ? m.pricing : null }
  })

  // settings
  h(Channels.settings.get, none, () => core.settings.get())
  h(Channels.settings.set, z.tuple([LocalSettingsPatchSchema]), (patch) => core.settings.set(patch))

  // health, audit, updates
  h(Channels.health.check, none, () =>
    checkHealth({
      db: core.db,
      dbPath: core.paths.database,
      dataDir: core.paths.root,
      client: core.client,
      pairing: core.pairing,
      sync: core.sync,
      registry: core.registry,
      updateState: () => core.updater.current
    })
  )
  h(Channels.audit.list, z.tuple([AuditListQuerySchema]), (q) => core.audit.list(q))
  h(Channels.updates.check, none, () => core.updater.check())
  h(Channels.updates.install, none, () => core.updater.install())
}
