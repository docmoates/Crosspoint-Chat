import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `%APPDATA%\Crosspoint`: everything the app stores lives here.
 * `CROSSPOINT_DATA_DIR` overrides it in unpackaged (dev/test) runs only.
 */
export function dataDir(): string {
  const override = !app.isPackaged ? process.env['CROSSPOINT_DATA_DIR'] : undefined
  const dir = override || join(app.getPath('appData'), 'Crosspoint')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function appPaths(): {
  root: string
  deviceFile: string
  configFile: string
  database: string
  attachments: string
  projectFiles: string
  chromium: string
} {
  const root = dataDir()
  return {
    root,
    deviceFile: join(root, 'device.bin'),
    configFile: join(root, 'config.bin'),
    database: join(root, 'crosspoint.sqlite'),
    attachments: join(root, 'attachments'),
    projectFiles: join(root, 'project-files'),
    chromium: join(root, 'Chromium')
  }
}
