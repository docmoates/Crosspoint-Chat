# Crosspoint Chat (desktop)

Electron + electron-vite + React 19 + Tailwind CSS 4. Windows first. Provider keys, MCP servers, allowed
models and spend limits come from admin.docmoates.com after pairing; nothing is configured locally.

## Commands (from the repo root)

| Command | What it does |
|---|---|
| `pnpm install` | Installs the workspace; `postinstall` runs `electron-rebuild` for `better-sqlite3`. |
| `pnpm dev` | Starts the app with hot reload (`electron-vite dev`). |
| `pnpm typecheck` | `tsc --noEmit` for `packages/shared`, main/preload and renderer. |
| `pnpm test` | Vitest unit tests (`apps/desktop/test`). |
| `pnpm build` | Production bundles into `apps/desktop/out`. |
| `pnpm dist` | Build + NSIS installer into `apps/desktop/dist/`. Unsigned unless `CSC_LINK`/`CSC_KEY_PASSWORD` are set. |

Dev-only environment variables (ignored in the installed app):

- `CROSSPOINT_DATA_DIR=<folder>`: use a scratch data folder instead of `%APPDATA%\Crosspoint`.
- `CROSSPOINT_NO_PROTOCOL=1`: do not register `crosspoint://` for this checkout.

## Layout

```
src/main/
  index.ts          window, single-instance lock, crosspoint:// deep links
  core.ts           wires the services below
  ipc.ts            ipcMain.handle('crosspoint:<area>:<method>') with zod validation
  admin/            AdminClient (HTTP), PairingService (device token), ConfigSync (60 s poll, offline cache, revoke)
  providers/        ChatProvider interface, openai-compat (OpenRouter + any base URL), anthropic, cost math
  services/         chat runs, model catalog + tags, usage ledger/outbox/limits, files, artifacts, library, audit, health, settings
  db/               SQLite schema + migrations (plain SQLite for now, see db/encryption.md)
  updates.ts        electron-updater (GitHub Releases docmoates/Crosspoint-Chat)
src/preload/
  index.ts          contextBridge.exposeInMainWorld('crosspoint', api)
  index.d.ts        `window.crosspoint` typing for the renderer
src/renderer/       React UI
../../packages/shared/
  admin-contract.ts zod schemas for the admin API (pair, config, usage, audit)
  ipc.ts            zod schemas + types for every preload method and StreamEvent
  channels.ts       channel/event names (dependency-free, bundled into the preload)
```

## Data folder: `%APPDATA%\Crosspoint`

| Path | Contents |
|---|---|
| `device.bin` | Device token + host, encrypted with Electron `safeStorage` (DPAPI, current Windows user). |
| `config.bin` | Last admin config including provider keys, `safeStorage`-encrypted, for offline use. |
| `crosspoint.sqlite` | Conversations, messages, projects, artifacts, memories, model cache, tags, usage, audit chain. |
| `attachments/<id>/` | Copies of attached files. |
| `project-files/<project>/<id>/` | Project knowledge files. |
| `Chromium/` | Electron user data (including the key `safeStorage` uses; do not delete it separately). |

Keys live only in the main process. The renderer gets a sanitized config (`hasKey` flags, no secrets).
On a 401 from admin (`revoked` or bad token) the app deletes `device.bin` and `config.bin`, clears the
provider clients and model cache, and shows the pairing screen. Unpair does the same.

## Pairing

Admin > Devices > "Pair a new device" shows a code (`XXXX-XXXX`, 10 minutes) and a link
`crosspoint://pair?code=...&host=admin.docmoates.com`. Enter the code or click the link. Links that name
another host, or arrive while already paired, ask for confirmation first.
