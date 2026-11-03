# Crosspoint Chat — Build Plan

Self-hosted web chat at **ai.docmoates.com** with Claude Desktop / ChatGPT / Gemini feature parity, running on third-party model APIs (OpenRouter, OpenAI-compatible endpoints, Anthropic direct). Single user. Works on desktop browsers and Android (installable PWA).

Decisions already made (2026-11-03): web app, Cloudflare DNS, keys and provider config live in **admin.docmoates.com** (built in the other chat), providers OpenRouter + OpenAI-compatible + Anthropic, scope = "everything the subscriptions do".

Assumption to confirm: admin.docmoates.com runs on a VPS/Docker host with a Postgres database. This app's backend goes on the same host and reads provider keys from the admin's database or an internal `/internal/config` endpoint. If admin is on Cloudflare Workers instead, swap the API tier to Workers + Durable Objects + Containers (section 3 notes where).

---

## 1. Feature inventory (parity target)

| Area | Features |
|---|---|
| Chat core | Streaming, markdown + LaTeX + Mermaid, code blocks with copy/run, edit & resend, regenerate, branch/fork, stop, message search, pin, archive, folders, export (MD/JSON/PDF), share link |
| Models | Model picker populated live from OpenRouter catalog + custom endpoints + Anthropic; per-chat model; effort/thinking slider; temperature/system prompt overrides; per-task routing rules (cheap for titles/summaries); fallback chain; cost meter per message and per month |
| Attachments | Images (vision), PDFs, docs/xlsx/pptx, audio, video frames, camera capture on phone, drag-drop, paste |
| Tools (built-in) | Web search + fetch with citations, code interpreter (Python/Node sandbox with file I/O and charts), image generation (via OpenRouter image models), text-to-speech, speech-to-text (Whisper-compatible), calculator/date, memory read/write |
| Artifacts / Canvas | HTML/React/SVG/Mermaid preview, documents with inline editing, version history, diff between versions, download, publish to a public URL |
| Projects | Instructions, knowledge files (RAG with embeddings), project-scoped chats, project-scoped MCP/tool defaults |
| Coding agent | Workspace = git repo on the server (clone from GitHub or upload); file tree, editor, terminal, agent loop with read/write/edit/bash/grep tools; permission prompts (once / always / deny); plan mode; diff review and commit/PR via GitHub token; task checklist; subagents |
| MCP | Client for stdio (server-side), Streamable HTTP and SSE servers; OAuth for remote servers; tool/resource/prompt listing; per-chat enable toggles; connector gallery |
| Skills | Skill folders (SKILL.md + scripts) in the Claude Code format, uploaded or git-synced; slash commands; auto-trigger by description |
| Deep research | Multi-step planner → parallel searchers → synthesized report with citations; progress UI; cancel/resume |
| Computer use | Phase 4: browser automation via Playwright in a container, screenshot loop |
| Memory | Auto-extracted facts + explicit "remember this"; list/edit/delete; injected into system prompt; per-project memory |
| Voice | Push-to-talk and continuous voice mode (STT → model → TTS), works on Android |
| Scheduled tasks | Cron prompts that run and leave results in a chat (like ChatGPT Tasks) |
| Personalization | Custom instructions, nickname, response style, theme, keyboard shortcuts |
| Mobile | PWA manifest, service worker, offline chat history, share-target (share a page/image into the app), notifications for finished tasks |
| Admin link | Keys, provider enable/disable, spend limits, allowed models come from admin.docmoates.com; chat app shows read-only status |

## 2. Architecture

```
Browser / Android PWA  ──HTTPS──▶  Cloudflare (DNS + proxy + Access)
                                        │
                                        ▼
                               ai.docmoates.com
                        ┌──────────────┴──────────────┐
                        │  web  (static, Vite build)  │  served by Caddy or CF Pages
                        │  api  (Node 22, Hono)       │  SSE streaming, REST, WebSocket for agent
                        │  worker (BullMQ)            │  deep research, scheduled tasks, embeddings
                        │  sandbox (Docker-in-Docker) │  code interpreter, coding agent, MCP stdio servers
                        │  postgres + pgvector        │  chats, projects, memory, embeddings
                        │  redis                      │  queues, pub/sub for streams
                        │  minio (or local disk)      │  uploads, artifacts, workspace snapshots
                        └─────────────────────────────┘
                                        │
                     ┌──────────────────┼──────────────────┐
                     ▼                  ▼                   ▼
               OpenRouter      OpenAI-compatible URLs    Anthropic API
```

**Provider abstraction.** One internal `ChatProvider` interface: `stream(messages, tools, options) → AsyncIterable<Event>` where events are `text`, `thinking`, `tool_call`, `tool_result`, `usage`, `citation`, `done`. Three adapters:
- `openai-compat` (used for OpenRouter and custom base URLs): Chat Completions + Responses API where available, tool calling, vision, `reasoning` param passthrough.
- `anthropic`: Messages API with extended thinking, prompt caching, PDF input, server tools (web search), computer-use beta.
- Model catalog: OpenRouter `/models` pulled hourly; Anthropic and custom lists maintained in admin. Each model record carries context window, price, supports[vision, tools, reasoning, json].

**Agent loop.** Provider-agnostic: model emits tool calls → server dispatches to tool registry (built-in, MCP, skills) → results appended → repeat until `done` or step cap. Permission policy per tool (auto / ask / deny), with "ask" answered over WebSocket from the UI. Same loop powers chat tools, coding agent and deep research (different tool sets and system prompts).

**Sandbox.** Each workspace is a Docker container (`node:22` + `python:3.12` base) with the repo mounted, no network by default, CPU/mem limits, 30-min idle kill. Code interpreter uses a short-lived container per execution with a shared `/mnt/data` per chat.

**Config from admin.** The API reads `providers`, `api_keys`, `model_allowlist`, `spend_limits` from the admin's Postgres (read-only role) and caches for 60 s. Chat UI shows provider status only; the "Edit" button deep-links to admin.docmoates.com.

**Auth.** Single user: Cloudflare Access (Google login on docmoates.com) in front, plus the app validates the `Cf-Access-Jwt-Assertion` header. No in-app password. Shared artifact links are public routes outside Access.

## 3. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + Vite + TypeScript, Tailwind, shadcn/ui, Zustand, TanStack Query, react-markdown + Shiki + KaTeX + Mermaid, CodeMirror 6 for editor | Fastest path to a polished Claude/ChatGPT-class UI; PWA via vite-plugin-pwa |
| API | Node 22 + Hono + Zod, Drizzle ORM, SSE for streams, WebSocket (ws) for agent sessions | Lightweight, same language as MCP SDK and Vercel AI SDK |
| LLM glue | Vercel AI SDK (`ai`) with `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic`; `@modelcontextprotocol/sdk` for MCP | Mature streaming + tool-call normalization across providers |
| Jobs | BullMQ on Redis | Deep research, cron tasks, embeddings |
| DB | Postgres 16 + pgvector | Chats, projects, RAG |
| Storage | MinIO (S3 API) | Uploads, artifacts, sandbox snapshots |
| Sandbox | Docker via dockerode; Playwright image for computer use | Isolation |
| Deploy | Docker Compose on the VPS, Caddy for TLS, Cloudflare proxied DNS + Access | Simple, one host |
| CF Workers alternative | Pages for web, Workers + Durable Objects for API/streams, Containers for sandbox, D1→Postgres via Hyperdrive | Only if admin already lives on Workers |

## 4. Data model (core tables)

`users` (1 row) · `providers` (mirror of admin) · `models` (catalog cache) · `projects` · `project_files` + `chunks(embedding vector)` · `conversations` (project_id, model, settings, parent_message_id for branches) · `messages` (role, parts JSON: text/thinking/tool_call/tool_result/attachment/citation, usage, cost) · `attachments` · `artifacts` + `artifact_versions` · `memories` · `mcp_servers` · `skills` · `workspaces` (repo url, container id, status) · `agent_runs` + `agent_events` · `scheduled_tasks` + `runs` · `shares`.

## 5. Phases

### Phase 0 — Foundation (week 1)
- Monorepo: `apps/web`, `apps/api`, `apps/worker`, `packages/providers`, `packages/shared`, `infra/`.
- Docker Compose (postgres, redis, minio, api, web, worker, caddy). Cloudflare DNS A record for `ai` via Cloudflare connector, proxied, Access policy = your Google account.
- Provider adapters + model catalog sync from OpenRouter. Config reader for admin DB. Smoke: `POST /chat` streams a reply from each provider.
- **Done when:** ai.docmoates.com loads behind Access and streams a hello from OpenRouter, a custom endpoint and Anthropic.

### Phase 1 — Chat parity (weeks 2–3)
- Full chat UI from the mockup: sidebar, threads, markdown/code/LaTeX/Mermaid, streaming, stop, edit/regenerate/branch, search, folders, pins, export, share.
- Model picker with live catalog, cost per message, thinking/effort controls, per-task routing rules (titles, summaries use cheap model). User-editable model tags (coding, images, cheap, vision, local…) stored per model, shown as chips and used as a filter in the picker.
- Attachments: images, PDFs, office docs (server-side text extraction), paste/drag/camera.
- Memory v1 (explicit + auto-extract) and custom instructions.
- PWA install, offline history cache, Android share-target.
- **Done when:** daily-driver replacement for basic ChatGPT/Claude chat on phone and desktop.

### Phase 2 — Tools and artifacts (weeks 4–5)
- Tool registry + permission policy. Built-ins: web search (Brave/Tavily/Exa key from admin) + fetch with citations, code interpreter sandbox with file outputs and charts, image generation, TTS/STT.
- Artifacts pane: HTML/React/SVG/Mermaid/document rendering, versions, diff, download, publish.
- Projects with knowledge files and RAG (pgvector, embeddings via OpenRouter or a local model).
- Voice mode (push-to-talk + continuous).
- **Done when:** tool calls stream into the UI with cards, artifacts render and version, projects answer from their files.

### Phase 3 — MCP, skills, coding agent (weeks 6–8)
- MCP client: stdio servers run in the sandbox container, HTTP/SSE remote with OAuth; tools/resources/prompts surfaced; per-chat toggles; connector gallery.
- Skills: upload or git-sync folders, SKILL.md parsing, slash commands, auto-trigger.
- Coding agent: workspace containers, clone/upload repo, file tree + CodeMirror, terminal (xterm.js over WebSocket), agent loop with read/edit/write/bash/grep tools, plan mode, permission prompts, diff review, commit/PR via GitHub token, subagents.
- **Done when:** you can point it at a GitHub repo, ask for a change, review the diff, and open a PR from the phone.

### Phase 4 — Deep research, computer use, scheduled tasks (weeks 9–10)
- Deep research pipeline in the worker with progress events and a cited report artifact.
- Computer use: Playwright container + screenshot loop (Anthropic computer-use tool or model-agnostic click-by-coordinate tool).
- Scheduled tasks (cron prompts) with notifications (web push on Android).
- Spend dashboard mirrored from admin; monthly limits enforced.
- **Done when:** parity list in section 1 fully checked.

### Phase 5 — Polish
- Keyboard shortcuts, command palette, themes, accessibility pass, Lighthouse PWA score, backups (pg_dump + minio to Backblaze), E2E tests (Playwright), load test of streaming.

## 6. Risks and choices to make early

- **Sandbox safety.** Docker-in-Docker on the same VPS as admin is the weak point. Mitigation: separate Docker network, no host mounts beyond the workspace volume, gVisor if the VPS kernel allows; or a second cheap VPS just for sandboxes.
- **Provider feature gaps.** Extended thinking, prompt caching, PDF input and computer use are Anthropic-direct features. Through OpenRouter some are passthrough, some not. The adapter advertises capabilities per model so the UI greys out what a model cannot do.
- **Web search source.** Needs a search API key (Brave is cheapest, Tavily/Exa are better for agents). Add to admin as a "tool provider".
- **Android.** PWA covers install, camera, share-target, push. If you later want Play Store, wrap with Capacitor; no code change.
- **Admin coupling.** Decide this week whether the chat API reads admin's DB directly or admin exposes an internal HTTP config endpoint. Direct DB read is simpler; HTTP keeps the two deployable apart.

## 7. Repo layout

```
Crosspoint-Chat/
  apps/web/          React PWA
  apps/api/          Hono API + agent loop + MCP client
  apps/worker/       BullMQ jobs: research, cron, embeddings, catalog sync
  packages/providers/ChatProvider interface + openai-compat + anthropic adapters
  packages/shared/   zod schemas, types, tool definitions
  packages/tools/    built-in tools (search, interpreter, image, tts, memory)
  infra/             docker-compose.yml, Caddyfile, sandbox Dockerfiles, cloudflare/
  mockup/            static design mockup; model tags (coding, images, cheap…) are user-editable in Settings › Models and filter the picker
  docs/              PLAN.md, ADRs
```

## 8. Immediate next steps

1. Confirm the admin.docmoates.com stack (VPS/Docker + Postgres assumed) and how config is shared (DB read vs HTTP).
2. Approve mockup, note changes.
3. Phase 0: scaffold monorepo, Compose stack, provider adapters, Cloudflare DNS + Access.
