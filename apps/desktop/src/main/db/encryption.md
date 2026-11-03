# Database encryption (planned)

`%APPDATA%\Crosspoint\crosspoint.sqlite` is **plain SQLite** today. Secrets never go in it: the device
token (`device.bin`) and the admin config with provider keys (`config.bin`) are separate files encrypted
with Electron `safeStorage` (DPAPI, bound to the Windows user). The database holds conversations,
attachments metadata, usage and the audit chain, which are private but not credentials.

Plan (PLAN.md Phase 0, "SQLCipher database"):

1. Swap `better-sqlite3` for `better-sqlite3-multiple-ciphers` (same API, SQLCipher-compatible) and
   rebuild it for Electron with `@electron/rebuild`.
2. Generate a random 32-byte key on first run; store it with `safeStorage` in `db.key`.
3. On open: `PRAGMA cipher = 'sqlcipher'; PRAGMA key = "x'<hex>'";` before any other statement.
4. Migrate an existing plain file with `ATTACH ... KEY` + `sqlcipher_export`, verify, then replace.
5. Back up `db.key` with the encrypted backup zip; without it the database is unrecoverable.

The `TODO(sqlcipher)` marker in `db/index.ts` is where the key pragma goes.
