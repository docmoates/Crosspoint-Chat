> **Update (router):** Devices no longer receive provider keys, model lists, custom endpoints or a search key. `GET /api/devices/me/config` returns `gateway.path`, `plan`, `limits` and `spend`. The app sends OpenAI-style chat requests to `POST {gateway.path}/chat/completions` with its device token and `model: "auto"` (or `system:title`). The server picks the route, topics and model, adds the prompts, holds the keys and records spend, so `POST /usage` no longer adds to spend. Routes, prompts, topics and the catalog are edited at `/router` in admin. Older sections below describe the previous shape.

> **Accounts and data:** `POST /api/auth/sign-in` and `POST /api/auth/accept-invite` return a device token linked to the account. `POST /api/devices/me/sync/push` and `GET /api/devices/me/sync/pull?since=` carry chats, projects, memory and artifacts. `PUT` and `GET /api/devices/me/files/:id` carry files (50 MB each). `POST {gateway.path}/knowledge` with `{ query }` returns `{ card }`; a card with `cleaning: true` should be requested again shortly. The chat stream may include a `crosspoint` field with `image` or `video` when the router created media; `GET {gateway.path}/media/video/:id` and `/content` follow a video job.

# Admin contract: Crosspoint Chat <-> admin.docmoates.com

Version 1.1 (2026-11-05). Implemented in `apps/docmoates` (Publications repo, `D:\repos\Publications`), a Cloudflare Worker with D1 live at admin.docmoates.com since 2026-11-05, and consumed by the Windows app. The TypeScript mirror lives in `packages/shared/admin-contract.ts` in this repo; the admin side validates with zod in JS. Keep both in step.

## Auth

- Device token: `dmd_<12 hex id>_<32 base64url chars>`. Admin stores only `sha256(token)`. Sent as `Authorization: Bearer <token>` on every `/api/devices/me/*` call.
- All `/api/*` routes live on the **admin host only**, answer JSON, skip the HTML session/CSRF/owner gates, and are rate limited (60/min per token, 10/min per IP for `/pair`).
- Errors: `{ "error": "<message>", "code": "unauthorized|revoked|bad_code|rate_limited|invalid" }` with 401/403/429/400. A device whose token is revoked gets 401 `code:"revoked"`; the app then wipes its key cache and shows the pairing screen.

## Pairing

1. Owner opens Admin > Devices > "Pair a new device". Admin creates a one-time `pairing_codes` row: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, grouped `XXXX-XXXX`, expires in 10 minutes. Page shows the code and the link `crosspoint://pair?code=XXXX-XXXX&host=admin.docmoates.com`.
2. App: `POST /api/devices/pair` body `{ "code": "XXXX-XXXX", "name": "DESKTOP-XYZ", "os": "Windows 11 10.0.28000", "app_version": "0.1.0" }` -> 200 `{ "device_id": "<12 hex>", "token": "dmd_...", "config_version": 1 }`. Code is marked used; wrong or expired -> 400 `bad_code`.
3. App stores the token with Electron `safeStorage` (DPAPI) under `%APPDATA%\Crosspoint\device.bin`.

## GET /api/devices/me/config

```json
{
  "config_version": 7,
  "device": { "id": "a1b2c3d4e5f6", "name": "DESKTOP-XYZ", "created_at": "...", "last_seen_at": "..." },
  "providers": [
    { "id": "openrouter", "kind": "openrouter", "label": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "api_key": "sk-or-...", "enabled": true },
    { "id": "anthropic",  "kind": "anthropic",  "label": "Anthropic",  "base_url": "https://api.anthropic.com", "api_key": "sk-ant-...", "enabled": true },
    { "id": "openai",     "kind": "openai-compatible", "label": "OpenAI", "base_url": "https://api.openai.com/v1", "api_key": "sk-...", "enabled": true },
    { "id": "custom:<slug>", "kind": "openai-compatible", "label": "<name>", "base_url": "https://.../v1", "api_key": "...", "enabled": true }
  ],
  "search": { "brave_api_key": "... or null", "monthly_quota": 2000 },
  "allowed_models": [],
  "default_models": { "chat": "anthropic/claude-sonnet-4.5", "helper": "openai/gpt-4o-mini" },
  "limits": { "monthly_usd": 100, "daily_usd": 5, "per_message_warn_usd": 0.5 },
  "spend": { "month_usd": 12.34, "today_usd": 0.56, "month": "2026-11" }
}
```

- `providers` come from admin's existing integrations `openrouter`, `anthropic`, `openai` (present when `api_key` is set) plus rows of a new `custom_endpoints` table (slug, name, base_url, api_key enc, enabled).
- `search.brave_api_key` from a new integration `brave` (field `api_key`, secret).
- `allowed_models`: empty array means "all". Strings are OpenRouter-style ids (`vendor/model`); for Anthropic direct use the raw model id.
- `config_version` increments on every admin write that affects this payload (`chat_settings.config_version`). App polls every 60 s with `If-None-Match: "<config_version>"`; admin returns 304 when unchanged. Each call updates `devices.last_seen_at`.
- Removed in contract v1.1 (2026-11-03): `mcp_servers` and `limits.sub_chat_usd` / `limits.sub_chat_steps`. Nothing in the app consumed them. The app's parser ignores unknown keys, so an admin that still sends them keeps working; admin should stop sending them and drop the editors (see "Admin console pages").

## POST /api/devices/me/usage

Body `{ "events": [ { "id": "<uuid>", "at": "ISO", "provider": "openrouter", "model": "...", "path": "cloud|local|cache", "kind": "chat|helper|search|image|embedding", "tokens_in": 123, "tokens_out": 45, "cached_tokens": 0, "cost_usd": 0.0012, "conversation_id": "<uuid>" } ] }` (max 200 events). Admin dedupes on `id` (table `device_usage`, PK id). Returns `{ "ok": true, "accepted": n, "spend": { "month_usd": ..., "today_usd": ... } }`. App keeps unsent events in `usage_outbox` and retries.

## POST /api/devices/me/audit

Body `{ "events": [ { "id": "<uuid>", "at": "ISO", "kind": "tool_call|permission|outbound|mcp_approve|sync|error", "summary": "...", "hash": "<hex>" } ] }` (daily summary, max 500). Stored in `device_audit`. Returns `{ "ok": true }`.

Status (2026-11-03): admin stores these rows but has no page that shows them. Either add a "last 50 events" list under each device, or drop this upload. Decision: **drop it** until there is a reader; the app keeps its local audit log (Settings > Data and audit). The endpoint may stay for compatibility.

## Admin console pages (owner only)

Live since 2026-11-05 (v1.1): **one page, `/crosspoint`**, with three sections, replacing the four v1 pages. Everything the desktop app consumes lives on this one screen.

1. **Devices**: table (name, os, version, last seen, month spend). A "Pair a new device" button at the top of the table reveals the code and `crosspoint://` link inline (10 min); no separate page. Per device: rename, **Revoke** (sets `revoked_at`).
2. **Models and limits**: "Allow all models" toggle (default on, = empty `allowed_models`); when off, a textarea of allowed ids, one per line. Default chat model, default helper model. Three limits: monthly USD, daily USD, per-message warning USD. The Brave Search key and its monthly quota live here too (moved from Integrations) so the app's whole config is on one screen. Saving bumps `config_version`.
3. **Endpoints**: custom OpenAI-compatible endpoints (slug, name, base URL, key write-only, enabled).

Removed: the `/mcp-servers` page and the `mcp_servers` table (nothing consumes MCP yet; re-add with the client support), the sub-chat limits, and the per-device usage table (the app shows spend itself; admin keeps the month total in the Devices table). Provider keys for OpenRouter, Anthropic and OpenAI stay under Integrations. Every write and every revoke is audited. Sidebar nav: one "Crosspoint Chat" entry.

The v1 paths `/devices`, `/endpoints`, `/mcp-servers` and `/chat-settings` redirect to `/crosspoint`. Hosting moved from the Azure VM to a Cloudflare Worker (`docmoates-portal`) with D1 on 2026-11-05; the v1 data was not carried over, so devices paired before that date must be paired again.

## Implementation notes (as built in admin commit b463ab4c1)

1. `spend` covers all devices, not just the calling one.
2. Usage and audit ids are unique across all devices; a resent id is ignored.
3. One event with an unknown `kind` or `path` rejects the whole batch with 400 `invalid`; the app must drop such events from its outbox, not retry them.
4. `search.monthly_quota` comes from an optional brave field, default 2000.
5. Disabled custom endpoints and MCP servers are still sent with `enabled:false`; an endpoint with no key sends `api_key: ""`.
6. Config sends `ETag: "<version>"`; `If-None-Match` accepts `W/` and unquoted values; 304 has an empty body and still updates `last_seen_at`.
7. Renaming a device and saving or clearing the openrouter, anthropic, openai or brave integration also bump `config_version`.
8. Pair codes work in any case, with or without the dash; `name`, `os`, `app_version` are optional (missing name becomes "Device").
9. 404, 405, 413 and 500 use code `invalid`; 429 sends `Retry-After: 60`.

## App side (apps/desktop/src/main/admin, services/usage.ts)

- Spend shown and enforced is admin's all-device `spend` plus this PC's events still in the outbox (note 1).
- Usage and audit uploads validate each event against the contract first; on 400 `invalid` (or 413) the batch is halved until the rejected events are isolated, and those are dropped and audited, never retried (note 3). 5xx is always retried, even when labelled `invalid` (note 9).
- `Retry-After` (seconds or HTTP date; 60 s assumed on 429) sets the next attempt for config polling, the usage outbox and audit posts (note 9).
- `If-None-Match` sends the quoted version `"<n>"`; 304 keeps the cached config (note 6). Providers with `enabled:false`, an empty `api_key` or an unparseable `base_url` are kept in config but never used (note 5).
- Only a JSON 401 from the device API (`unauthorized`/`revoked`) wipes the token; redirects (303) and HTML answers (e.g. 403) are reported as "device API may not be deployed yet".

## Tables (admin, SQLite)

`devices (id TEXT PK, name, os, app_version, token_hash, created_at, last_seen_at, revoked_at)`, `pairing_codes (code PK, created_at, expires_at, used_at, device_id)`, `custom_endpoints (slug PK, name, base_url, api_key_enc, enabled, created_at)`, `chat_settings (id=1, allowed_models_json, default_chat, default_helper, monthly_usd, daily_usd, per_message_warn_usd, config_version)`. v1 also has `mcp_servers (...)` and the `sub_chat_usd`, `sub_chat_steps` columns; drop them with the v1.1 page consolidation, `device_usage (id TEXT PK, device_id, at, provider, model, path, kind, tokens_in, tokens_out, cached_tokens, cost_usd, conversation_id)`, `device_audit (id TEXT PK, device_id, at, kind, summary, hash)`.
