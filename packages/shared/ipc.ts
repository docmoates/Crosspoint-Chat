/**
 * IPC contract between the Electron main process and the renderer (docs/APP-CONTRACT.md).
 * zod schemas validate every payload in main; inferred types are shared by main, preload and renderer.
 * The renderer never sees provider keys, MCP env/headers or the device token.
 */
import { z } from 'zod'
import { ProviderKindSchema } from './admin-contract'

// ---------- pairing ----------

export const PairingStatusSchema = z.object({
  paired: z.boolean(),
  device: z.object({ id: z.string(), name: z.string() }).optional(),
  host: z.string(),
  lastSyncAt: z.string().optional(),
  error: z.string().optional()
})
export type PairingStatus = z.infer<typeof PairingStatusSchema>

export type PairResult = { ok: true } | { ok: false; error: string }

// ---------- sanitized config ----------

export const AppProviderSchema = z.object({
  id: z.string(),
  kind: ProviderKindSchema,
  label: z.string(),
  base_url: z.string(),
  enabled: z.boolean(),
  hasKey: z.boolean()
})
export type AppProvider = z.infer<typeof AppProviderSchema>

export const AppConfigSchema = z.object({
  config_version: z.number(),
  providers: z.array(AppProviderSchema),
  search: z.object({ hasBraveKey: z.boolean(), monthly_quota: z.number().nullable() }),
  mcp_servers: z.array(z.object({ id: z.string(), name: z.string(), transport: z.enum(['stdio', 'http']), enabled: z.boolean() })),
  allowed_models: z.array(z.string()),
  default_models: z.object({ chat: z.string().nullable(), helper: z.string().nullable() }),
  limits: z.object({
    monthly_usd: z.number().nullable(),
    daily_usd: z.number().nullable(),
    per_message_warn_usd: z.number().nullable(),
    sub_chat_usd: z.number().nullable(),
    sub_chat_steps: z.number().nullable()
  }),
  spend: z.object({ month_usd: z.number(), today_usd: z.number(), month: z.string().optional() })
})
export type AppConfig = z.infer<typeof AppConfigSchema>

export const EMPTY_APP_CONFIG: AppConfig = {
  config_version: 0,
  providers: [],
  search: { hasBraveKey: false, monthly_quota: null },
  mcp_servers: [],
  allowed_models: [],
  default_models: { chat: null, helper: null },
  limits: { monthly_usd: null, daily_usd: null, per_message_warn_usd: null, sub_chat_usd: null, sub_chat_steps: null },
  spend: { month_usd: 0, today_usd: 0 }
}

// ---------- models + tags ----------

/** Prices are USD per 1M tokens. null when the catalog does not publish a price. */
export const ModelPricingSchema = z.object({ in: z.number().nullable(), out: z.number().nullable() })
export type ModelPricing = z.infer<typeof ModelPricingSchema>

export const ModelInfoSchema = z.object({
  /** Unique across providers: OpenRouter ids as-is (`vendor/model`), Anthropic raw ids, custom endpoints `<providerId>:<model>`. */
  id: z.string(),
  /** Provider id from config (`openrouter`, `anthropic`, `openai`, `custom:<slug>`). */
  provider: z.string(),
  name: z.string(),
  context: z.number().nullable(),
  pricing: ModelPricingSchema,
  capabilities: z.object({ vision: z.boolean(), tools: z.boolean(), reasoning: z.boolean() }),
  tags: z.array(z.string())
})
export type ModelInfo = z.infer<typeof ModelInfoSchema>

export const TagSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  color: z.string().max(32)
})
export type Tag = z.infer<typeof TagSchema>

// ---------- attachments ----------

export const AttachmentKindSchema = z.enum(['image', 'pdf', 'text', 'file'])
export const AttachmentRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  kind: AttachmentKindSchema
})
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>

export const PasteDataSchema = z.object({
  name: z.string().min(1).max(260),
  mime: z.string().min(1).max(200),
  base64: z.string().max(50 * 1024 * 1024 * 1.37)
})
export type PasteData = z.infer<typeof PasteDataSchema>

// ---------- chat ----------

export const ThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high'])
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>

export const ChatSettingsSchema = z.object({
  systemPrompt: z.string().max(100_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
  thinking: ThinkingLevelSchema.optional()
})
export type ChatSettings = z.infer<typeof ChatSettingsSchema>

export const ChatSendInputSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().max(2_000_000),
  attachments: z.array(AttachmentRefSchema).max(50).optional(),
  modelId: z.string().optional(),
  settings: ChatSettingsSchema.optional()
})
export type ChatSendInput = z.infer<typeof ChatSendInputSchema>

export const UsageInfoSchema = z.object({
  provider: z.string(),
  model: z.string(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  cachedTokens: z.number(),
  costUsd: z.number()
})
export type UsageInfo = z.infer<typeof UsageInfoSchema>

const StreamBase = { runId: z.string(), conversationId: z.string(), messageId: z.string() }
export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({ ...StreamBase, type: z.literal('text'), delta: z.string() }),
  z.object({ ...StreamBase, type: z.literal('thinking'), delta: z.string() }),
  z.object({ ...StreamBase, type: z.literal('tool_call'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ ...StreamBase, type: z.literal('tool_result'), id: z.string(), output: z.unknown(), isError: z.boolean().optional() }),
  z.object({ ...StreamBase, type: z.literal('usage'), usage: UsageInfoSchema }),
  z.object({
    ...StreamBase,
    type: z.literal('notice'),
    level: z.enum(['info', 'warn', 'error']),
    code: z.string().optional(),
    message: z.string()
  }),
  z.object({ ...StreamBase, type: z.literal('error'), code: z.string().optional(), message: z.string() }),
  z.object({
    ...StreamBase,
    type: z.literal('done'),
    finishReason: z.enum(['stop', 'length', 'stopped', 'error', 'tool_calls', 'refusal']),
    title: z.string().optional()
  })
])
export type StreamEvent = z.infer<typeof StreamEventSchema>
export type StreamEventType = StreamEvent['type']

// ---------- conversations + messages ----------

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  modelId: z.string().nullable(),
  settings: ChatSettingsSchema,
  pinned: z.boolean(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type Conversation = z.infer<typeof ConversationSchema>

export const ConversationSummarySchema = ConversationSchema.extend({
  messageCount: z.number(),
  lastMessageAt: z.string().nullable(),
  preview: z.string()
})
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('attachment'), attachment: AttachmentRefSchema }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), output: z.unknown(), isError: z.boolean().optional() }),
  z.object({ type: z.literal('notice'), level: z.enum(['info', 'warn', 'error']), message: z.string(), code: z.string().optional() })
])
export type MessagePart = z.infer<typeof MessagePartSchema>

export const MessageStatusSchema = z.enum(['complete', 'streaming', 'stopped', 'error'])
export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(MessagePartSchema),
  modelId: z.string().nullable(),
  provider: z.string().nullable(),
  status: MessageStatusSchema,
  usage: UsageInfoSchema.nullable(),
  costUsd: z.number().nullable(),
  /** The user message this assistant reply answers (for regenerate). */
  parentId: z.string().nullable(),
  createdAt: z.string()
})
export type Message = z.infer<typeof MessageSchema>

export const ConversationListQuerySchema = z
  .object({ projectId: z.string().optional(), search: z.string().max(500).optional(), limit: z.number().int().positive().max(1000).optional() })
  .optional()
export type ConversationListQuery = z.infer<typeof ConversationListQuerySchema>

export const ConversationCreateInputSchema = z
  .object({ projectId: z.string().optional(), modelId: z.string().optional(), title: z.string().max(500).optional() })
  .optional()
export type ConversationCreateInput = z.infer<typeof ConversationCreateInputSchema>

export const ConversationPatchSchema = z
  .object({
    title: z.string().max(500),
    modelId: z.string().nullable(),
    settings: ChatSettingsSchema,
    pinned: z.boolean(),
    archived: z.boolean(),
    projectId: z.string().nullable()
  })
  .partial()
export type ConversationPatch = z.infer<typeof ConversationPatchSchema>

// ---------- projects ----------

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type Project = z.infer<typeof ProjectSchema>

export const ProjectCreateSchema = z.object({ name: z.string().min(1).max(200), instructions: z.string().max(200_000).optional() })
export const ProjectPatchSchema = z.object({ name: z.string().min(1).max(200), instructions: z.string().max(200_000) }).partial()
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>

export const ProjectFileSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  /** Characters of extracted text available to the model (0 when not extractable). */
  textChars: z.number(),
  createdAt: z.string()
})
export type ProjectFile = z.infer<typeof ProjectFileSchema>

// ---------- artifacts ----------

export const ArtifactKindSchema = z.enum(['html', 'svg', 'mermaid', 'jsx', 'markdown', 'code'])
export const ArtifactSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  name: z.string(),
  kind: ArtifactKindSchema,
  language: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type Artifact = z.infer<typeof ArtifactSchema>
export type ArtifactWithContent = Artifact & { content: string }

// ---------- memories ----------

export const MemorySchema = z.object({ id: z.string(), text: z.string(), source: z.enum(['user', 'auto']), createdAt: z.string() })
export type Memory = z.infer<typeof MemorySchema>

// ---------- usage ----------

export const UsageSummarySchema = z.object({
  month_usd: z.number(),
  today_usd: z.number(),
  /** Fraction 0..1 of this month's spend that ran on local models (always 0 until local models ship). */
  local_share: z.number(),
  byDay: z.array(z.object({ day: z.string(), usd: z.number() }))
})
export type UsageSummary = z.infer<typeof UsageSummarySchema>

export const UsageDetailSchema = UsageInfoSchema.extend({ messageId: z.string(), at: z.string(), kind: z.string() })
export type UsageDetail = z.infer<typeof UsageDetailSchema>

// ---------- local settings ----------

export const LocalSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  font: z.string().max(200),
  sendOnEnter: z.boolean(),
  defaultModelOverride: z.string().nullable(),
  dailyCapUsd: z.number().nonnegative().nullable(),
  /** Read-only: where data lives (%APPDATA%\Crosspoint). Writes are ignored. */
  dataFolder: z.string()
})
export type LocalSettings = z.infer<typeof LocalSettingsSchema>
export const LocalSettingsPatchSchema = LocalSettingsSchema.partial()

// ---------- health, audit, updates ----------

export const UpdateStateSchema = z.object({
  status: z.enum(['idle', 'disabled', 'checking', 'available', 'not-available', 'downloading', 'downloaded', 'error']),
  version: z.string().optional(),
  progress: z.number().optional(),
  error: z.string().optional()
})
export type UpdateState = z.infer<typeof UpdateStateSchema>

const CheckSchema = z.object({ ok: z.boolean(), latencyMs: z.number().optional(), error: z.string().optional() })
export const HealthReportSchema = z.object({
  checkedAt: z.string(),
  admin: CheckSchema.extend({ host: z.string(), paired: z.boolean() }),
  providers: z.array(CheckSchema.extend({ id: z.string(), label: z.string(), kind: ProviderKindSchema })),
  db: CheckSchema.extend({ path: z.string(), sizeBytes: z.number().optional() }),
  disk: CheckSchema.extend({ path: z.string(), freeBytes: z.number().nullable() }),
  update: UpdateStateSchema
})
export type HealthReport = z.infer<typeof HealthReportSchema>

export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(['tool_call', 'permission', 'outbound', 'mcp_approve', 'sync', 'error']),
  summary: z.string(),
  hash: z.string(),
  prevHash: z.string()
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>
export const AuditListQuerySchema = z.object({ limit: z.number().int().positive().max(1000).optional(), before: z.string().optional() }).optional()

// ---------- api surface ----------

export interface CrosspointApi {
  app: { version(): Promise<string>; openExternal(url: string): Promise<void>; openPath(p: string): Promise<void> }
  pairing: {
    status(): Promise<PairingStatus>
    pair(code: string, host?: string): Promise<PairResult>
    unpair(): Promise<void>
    syncNow(): Promise<void>
    onStatus(cb: (s: PairingStatus) => void): () => void
  }
  config: { get(): Promise<AppConfig>; onChange(cb: (c: AppConfig) => void): () => void }
  models: {
    list(): Promise<ModelInfo[]>
    refresh(): Promise<void>
    setTags(modelId: string, tags: string[]): Promise<void>
    tags: { list(): Promise<Tag[]>; save(t: Tag): Promise<void>; remove(id: string): Promise<void> }
  }
  chat: {
    send(input: ChatSendInput): Promise<{ messageId: string; runId: string }>
    stop(runId: string): Promise<void>
    regenerate(messageId: string, modelId?: string): Promise<{ runId: string }>
    onEvent(cb: (e: StreamEvent) => void): () => void
  }
  conversations: {
    list(q?: ConversationListQuery): Promise<ConversationSummary[]>
    get(id: string): Promise<{ conversation: Conversation; messages: Message[] }>
    create(input?: ConversationCreateInput): Promise<Conversation>
    update(id: string, patch: ConversationPatch): Promise<void>
    remove(id: string): Promise<void>
  }
  projects: {
    list(): Promise<Project[]>
    create(p: { name: string; instructions?: string }): Promise<Project>
    update(id: string, patch: ProjectPatch): Promise<void>
    remove(id: string): Promise<void>
    files: { list(projectId: string): Promise<ProjectFile[]>; add(projectId: string): Promise<ProjectFile[]>; remove(id: string): Promise<void> }
  }
  attachments: { pick(): Promise<AttachmentRef[]>; fromPaste(data: PasteData): Promise<AttachmentRef> }
  artifacts: {
    list(conversationId: string): Promise<Artifact[]>
    get(id: string): Promise<ArtifactWithContent>
    save(id: string, content: string): Promise<void>
    exportTo(id: string): Promise<void>
  }
  memories: { list(): Promise<Memory[]>; add(text: string): Promise<Memory>; remove(id: string): Promise<void> }
  usage: { summary(): Promise<UsageSummary>; forMessage(messageId: string): Promise<UsageDetail | null> }
  settings: { get(): Promise<LocalSettings>; set(patch: Partial<LocalSettings>): Promise<void> }
  health: { check(): Promise<HealthReport> }
  audit: { list(q?: { limit?: number; before?: string }): Promise<AuditEntry[]> }
  updates: { check(): Promise<UpdateState>; install(): Promise<void> }
}

/** `ipcMain.handle` channel for an API method: `crosspoint:<area>:<method>` (nested areas joined with '.'). */
export const channel = (area: string, method: string): string => `crosspoint:${area}:${method}`

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

/** Shared small validators for IPC arguments. */
export const IdSchema = z.string().min(1).max(200)
export const UrlSchema = z.string().url().refine((u) => /^(https?|mailto):/i.test(u), 'only http(s) and mailto links')
