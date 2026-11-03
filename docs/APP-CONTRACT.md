# App contract: Electron main <-> renderer (preload API)

The renderer never sees provider keys or the device token. Everything goes through `window.crosspoint`, exposed by `apps/desktop/src/preload/index.ts` with `contextBridge`. All methods return Promises; streams use `on*` subscriptions that return an unsubscribe function. Types live in `packages/shared/ipc.ts` (zod schemas + inferred types) and are imported by both sides.

```ts
interface CrosspointApi {
  app: { version(): Promise<string>; openExternal(url: string): Promise<void>; openPath(p: string): Promise<void> };
  pairing: {
    status(): Promise<PairingStatus>;   // { paired: boolean; device?: { id: string; name: string }; host: string; lastSyncAt?: string; error?: string }
    pair(code: string, host?: string): Promise<{ ok: true } | { ok: false; error: string }>;
    unpair(): Promise<void>;
    syncNow(): Promise<void>;
    onStatus(cb: (s: PairingStatus) => void): () => void;      // fires after every sync, revoke, deep link
  };
  config: {   // sanitized mirror of admin config: NO api keys, NO mcp env/headers
    get(): Promise<AppConfig>;   // providers [{id,kind,label,base_url,enabled,hasKey}], search {hasBraveKey}, mcp_servers [{id,name,transport,enabled}], allowed_models, default_models, limits, spend, config_version
    onChange(cb: (c: AppConfig) => void): () => void;
  };
  models: {
    list(): Promise<ModelInfo[]>;   // merged catalog: OpenRouter /models (cached hourly in SQLite) + Anthropic + custom endpoints, filtered by allowed_models; {id, provider, name, context, pricing:{in,out}, capabilities:{vision,tools,reasoning}, tags:string[]}
    refresh(): Promise<void>;
    setTags(modelId: string, tags: string[]): Promise<void>;
    tags: { list(): Promise<Tag[]>; save(t: Tag): Promise<void>; remove(id: string): Promise<void> };
  };
  chat: {
    send(input: { conversationId: string; text: string; attachments?: AttachmentRef[]; modelId?: string; settings?: ChatSettings }): Promise<{ messageId: string; runId: string }>;
    stop(runId: string): Promise<void>;
    regenerate(messageId: string, modelId?: string): Promise<{ runId: string }>;
    onEvent(cb: (e: StreamEvent) => void): () => void;   // {runId, conversationId, messageId, type:'text'|'thinking'|'tool_call'|'tool_result'|'usage'|'notice'|'error'|'done', ...}
  };
  conversations: {
    list(q?: { projectId?: string; search?: string; limit?: number }): Promise<ConversationSummary[]>;
    get(id: string): Promise<{ conversation: Conversation; messages: Message[] }>;
    create(input?: { projectId?: string; modelId?: string; title?: string }): Promise<Conversation>;
    update(id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'settings' | 'pinned' | 'archived' | 'projectId'>>): Promise<void>;
    remove(id: string): Promise<void>;
  };
  projects: {
    list(): Promise<Project[]>; create(p: { name: string; instructions?: string }): Promise<Project>; update(id: string, patch: Partial<Project>): Promise<void>; remove(id: string): Promise<void>;
    files: { list(projectId: string): Promise<ProjectFile[]>; add(projectId: string): Promise<ProjectFile[]> /* opens file dialog */; remove(id: string): Promise<void> };
  };
  attachments: { pick(): Promise<AttachmentRef[]>; fromPaste(data: { name: string; mime: string; base64: string }): Promise<AttachmentRef> };
  artifacts: {
    list(conversationId: string): Promise<Artifact[]>;
    listAll(limit?: number): Promise<ArtifactListItem[]>;   // Artifact & { conversationTitle }, all non-archived chats, newest first; default 200, max 1000
    get(id: string): Promise<Artifact & { content: string }>; save(id: string, content: string): Promise<void>; exportTo(id: string): Promise<void>
  };
  memories: { list(): Promise<Memory[]>; add(text: string): Promise<Memory>; remove(id: string): Promise<void> };
  usage: {
    summary(): Promise<{ month_usd: number; today_usd: number; local_share: number; byDay: { day: string; usd: number }[] }>;   // month/today = admin all-device spend + this PC's unsent events; byDay is this PC only
    forMessage(messageId: string): Promise<UsageDetail | null>;   // UsageInfo + messageId, at, kind, pricing: {in,out} | null (catalog list price per 1M tokens)
  };
  settings: { get(): Promise<LocalSettings>; set(patch: Partial<LocalSettings>): Promise<void> };   // theme, font, fontSize (int 11-22, default 14), sendOnEnter, defaultModelOverride, dailyCapUsd, dataFolder
  health: { check(): Promise<HealthReport> };   // admin reachable, each provider ping, db ok, disk free, update state; every item may carry `fix` (plain-language next step)
  audit: { list(q?: { limit?: number; before?: string }): Promise<AuditEntry[]> };
  updates: { check(): Promise<UpdateState>; install(): Promise<void> };
}
```

Artifact previews: HTML and SVG artifacts are not rendered with `srcdoc`. Main registers the privileged scheme `crosspoint-artifact` (standard, secure) and serves `crosspoint-artifact://preview/<artifactId>?v=<version>` (helper `artifactPreviewUrl` in `packages/shared/channels.ts`) with the saved version's document and its own CSP (inline scripts allowed; scripts/styles also from cdnjs, jsDelivr, unpkg; images from data/blob/https; no fetch, frames or forms). The renderer embeds it in `<iframe sandbox="allow-scripts allow-modals">` without `allow-same-origin`, so artifact code runs in an opaque origin with no preload and no IPC. The renderer CSP allows `frame-src crosspoint-artifact:` only.

Rules: zod-validate every IPC payload in main; `ipcMain.handle` channel names are `crosspoint:<area>:<method>`; events are `crosspoint:event:<name>`. Deep link `crosspoint://pair?code=...&host=...` is handled in main (single instance lock) and triggers `pairing.pair`. Features from the plan that are not yet implemented (sub-chats, local models, image generation, web search, MCP tools, scheduled tasks) must render as honest empty/disabled states with a "coming soon" note, never with invented data.
