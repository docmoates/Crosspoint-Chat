import { app, BrowserWindow, dialog, shell } from 'electron'
import { join, resolve } from 'node:path'
import { DEFAULT_ADMIN_HOST, normalizeAdminHost } from '@shared/admin-contract'
import { Events } from '@shared/ipc'
import { handleArtifactProtocol, registerArtifactScheme } from './artifact-protocol'
import { createCore, type Core } from './core'
import { registerIpc } from './ipc'
import { appPaths } from './paths'

const PROTOCOL = 'crosspoint'
const RENDERER_URL = process.env['ELECTRON_RENDERER_URL']

// Keep Chromium data (including the safeStorage key in "Local State") under %APPDATA%\Crosspoint so it
// never moves if the product name changes. Must run before `ready`.
app.setPath('userData', appPaths().chromium)
app.setAppUserModelId('com.docmoates.crosspoint')
registerArtifactScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

function main(): void {
  let core: Core | null = null
  let win: BrowserWindow | null = null
  let pendingLink: string | null = findDeepLink(process.argv)

  registerProtocol()

  app.on('second-instance', (_e, argv) => {
    focus()
    const link = findDeepLink(argv)
    if (link) void handleDeepLink(link)
  })
  // macOS delivers links this way; harmless on Windows.
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (core) void handleDeepLink(url)
    else pendingLink = url
  })

  const send = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }

  void app.whenReady().then(() => {
    core = createCore({
      pairingStatus: (s) => send(Events.pairingStatus, s),
      configChange: (c) => send(Events.configChange, c),
      chat: (e) => send(Events.chat, e)
    })
    registerIpc(core, { isTrustedUrl, afterPair: () => undefined })
    handleArtifactProtocol(() => core?.artifacts ?? null)
    core.start()
    win = createWindow()
    if (pendingLink) {
      const link = pendingLink
      pendingLink = null
      win.webContents.once('did-finish-load', () => void handleDeepLink(link))
    }
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => core?.stop())

  function focus(): void {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  async function handleDeepLink(raw: string): Promise<void> {
    if (!core) {
      pendingLink = raw
      return
    }
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return
    }
    if (url.protocol !== `${PROTOCOL}:`) return
    const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase()
    if (action !== 'pair') return
    const code = url.searchParams.get('code') ?? ''
    const host = normalizeAdminHost(url.searchParams.get('host'))

    // A link can come from anywhere: confirm before pairing with an unfamiliar host or replacing a pairing.
    const familiar = host === DEFAULT_ADMIN_HOST || host === core.pairing.host
    if (!familiar || core.pairing.isPaired()) {
      const detail = !familiar
        ? `This link pairs Crosspoint Chat with ${host}, not ${DEFAULT_ADMIN_HOST}. That server would supply the keys and endpoints your chats use. Only continue if you set it up.`
        : `This device is already paired as "${core.pairing.device?.deviceName}". Pairing again replaces that link.`
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: ['Pair', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Pair this device?',
        message: `Pair with ${host}?`,
        detail
      }
      const res = await (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
      if (res.response !== 0) return
    }

    focus()
    const res = await core.pairing.pair(code, host)
    if (res.ok) {
      core.audit.append('sync', `paired via link as device ${core.pairing.device?.deviceId} with ${host}`)
      await core.sync.onPaired()
    } else {
      send(Events.pairingStatus, { ...core.sync.status(), error: res.error })
    }
  }
}

function registerProtocol(): void {
  // Dev/test runs can opt out so a scratch checkout does not claim crosspoint:// in the registry.
  if (!app.isPackaged && process.env['CROSSPOINT_NO_PROTOCOL'] === '1') return
  if (process.defaultApp && process.argv.length >= 2) {
    // Dev: electron.exe needs the app path as its first argument.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1]!)])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }
}

function findDeepLink(argv: string[]): string | null {
  return argv.find((a) => a.toLowerCase().startsWith(`${PROTOCOL}://`)) ?? null
}

function isTrustedUrl(url: string): boolean {
  if (RENDERER_URL && url.startsWith(RENDERER_URL)) return true
  return url.startsWith('file://')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 500,
    title: 'Crosspoint Chat',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#262624',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => win.show())

  // External links open in the browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  if (RENDERER_URL) void win.loadURL(RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}
