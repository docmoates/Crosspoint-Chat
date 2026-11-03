import { app } from 'electron'
import type { UpdateState } from '@shared/ipc'

/**
 * electron-updater against GitHub Releases (docmoates/Crosspoint-Chat, set in electron-builder.yml).
 * Tolerant by design: in dev, when offline, or when a release is unsigned/missing, it reports a state and never throws.
 */
export class Updater {
  private state: UpdateState = { status: 'idle' }
  private updater: import('electron-updater').AppUpdater | null = null
  private loading: Promise<void> | null = null

  constructor(private readonly onChange?: (s: UpdateState) => void) {
    if (!app.isPackaged) this.state = { status: 'disabled', error: 'Updates run only in the installed app.' }
  }

  get current(): UpdateState {
    return this.state
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.state
    try {
      await this.init()
      this.set({ status: 'checking' })
      const res = await this.updater!.checkForUpdates()
      if (!res || !res.isUpdateAvailable) this.set({ status: 'not-available' })
    } catch (err) {
      this.set({ status: 'error', error: friendly(err) })
    }
    return this.state
  }

  async install(): Promise<void> {
    if (this.state.status !== 'downloaded' || !this.updater) return
    this.updater.quitAndInstall(false, true)
  }

  private init(): Promise<void> {
    if (!this.loading) {
      this.loading = import('electron-updater').then(({ autoUpdater }) => {
        autoUpdater.autoDownload = true
        autoUpdater.autoInstallOnAppQuit = true
        autoUpdater.logger = null
        autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version }))
        autoUpdater.on('update-not-available', () => this.set({ status: 'not-available' }))
        autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', version: this.state.version, progress: Math.round(p.percent) }))
        autoUpdater.on('update-downloaded', (info) => this.set({ status: 'downloaded', version: info.version }))
        autoUpdater.on('error', (err) => this.set({ status: 'error', error: friendly(err) }))
        this.updater = autoUpdater
      })
    }
    return this.loading
  }

  private set(s: UpdateState): void {
    this.state = s
    this.onChange?.(s)
  }
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/404|latest\.yml|no published versions/i.test(msg)) return 'No release is published yet.'
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(msg)) return 'Could not reach GitHub Releases.'
  if (/signature|not signed|publisherName/i.test(msg)) return 'The update is not signed by the expected publisher.'
  return msg.split('\n')[0]!.slice(0, 300)
}
