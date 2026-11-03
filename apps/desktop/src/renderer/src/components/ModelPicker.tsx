import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState, type ReactElement } from 'react'
import { cn, ctx, perM } from '../lib/utils'
import type { ChatSettings, ModelInfo, ThinkingLevelValue } from '../lib/types'
import { useApp } from '../store/app'
import { defaultChatModel, providerLabel, resolveTag, useConfig } from '../store/config'
import { Seg, Soon, TagPill } from './ui/primitives'

export function modelName(models: ModelInfo[], id: string | undefined): string {
  if (!id) return 'Default'
  return models.find((m) => m.id === id)?.name ?? id
}

export function price(m: ModelInfo): string {
  if (m.pricing.in == null && m.pricing.out == null) return 'price n/a'
  if (m.pricing.in === 0 && m.pricing.out === 0) return 'free'
  return `$${perM(m.pricing.in)} / $${perM(m.pricing.out)}`
}

export const THINKING_LEVELS: { value: ThinkingLevelValue; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

export function ModelPicker(props: {
  value: string | undefined
  onChange: (id: string | undefined) => void
  settings: ChatSettings | undefined
  onSettings: (patch: Partial<ChatSettings>) => void
}): ReactElement {
  const { models, tags, config, refreshing, refreshModels } = useConfig()
  const openSettings = useApp((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<string>('')
  const [q, setQ] = useState('')

  const fallback = defaultChatModel(config)
  const selected = models.find((m) => m.id === (props.value ?? fallback))
  const effort: ThinkingLevelValue = props.settings?.thinking ?? 'off'

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const tag = filter ? resolveTag(tags, filter) : undefined
    const list = models.filter((m) => {
      if (tag && !m.tags.some((t) => t === tag.id || t.toLowerCase() === tag.name.toLowerCase())) return false
      if (needle && !`${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(needle)) return false
      return true
    })
    const map = new Map<string, ModelInfo[]>()
    for (const m of list) {
      const arr = map.get(m.provider) ?? []
      arr.push(m)
      map.set(m.provider, arr)
    }
    return [...map.entries()].map(([provider, items]) => ({
      provider,
      label: providerLabel(config, provider),
      items: items.sort((a, b) => a.name.localeCompare(b.name)),
    }))
  }, [models, tags, filter, q, config])

  const pick = (id: string | undefined): void => {
    props.onChange(id)
    setOpen(false)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="pill" title="Choose model">
          <span className="max-w-[220px] overflow-hidden text-ellipsis">
            {props.value ? modelName(models, props.value) : selected ? `Default · ${selected.name}` : 'Default'}
          </span>
          {effort !== 'off' && <span className="faint">· thinking {effort}</span>}
          <ChevronDown className="ic-xs" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu model-menu" side="top" align="start" sideOffset={6} collisionPadding={12}>
          <div className="flex items-center gap-2 px-2 pt-1 pb-2">
            <Search className="ic-sm faint" />
            <input
              className="flex-1 border-0 bg-transparent text-[13px] outline-none"
              placeholder="Search models"
              value={q}
              autoFocus
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search models"
            />
            <button
              type="button"
              className="iconbtn"
              style={{ width: 26, height: 26 }}
              title="Refresh catalog"
              onClick={() => void refreshModels()}
              disabled={refreshing}
            >
              <RefreshCw className={cn('ic-sm', refreshing && 'animate-spin')} />
            </button>
          </div>
          {tags.length > 0 && (
            <div className="tagfilter">
              <button type="button" className={cn(!filter && 'on')} onClick={() => setFilter('')}>
                All
              </button>
              {tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={cn(filter === t.id && 'on')}
                  style={filter === t.id ? undefined : { color: t.color, borderColor: `color-mix(in srgb, ${t.color} 45%, transparent)` }}
                  onClick={() => setFilter(filter === t.id ? '' : t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}

          <div className="eyebrow">Default</div>
          <button type="button" className={cn('menu-item', !props.value && 'on')} onClick={() => pick(undefined)}>
            <span>Default</span>
            <span className="sub">
              {fallback ? `${modelName(models, fallback)} · set in admin` : 'The default model set in admin'}
            </span>
            <span className="right">{!props.value && <Check className="ic-sm tick" />}</span>
          </button>

          {models.length === 0 && (
            <div className="px-2 py-3 text-[12.5px] muted">
              No models yet. The catalog arrives after pairing and sync; which models are allowed is set in admin.
            </div>
          )}
          {models.length > 0 && groups.length === 0 && (
            <div className="px-2 py-3 text-[12.5px] muted">No model matches this filter.</div>
          )}

          {groups.map((g) => (
            <div key={g.provider}>
              <div className="eyebrow">{g.label}</div>
              {g.items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={cn('menu-item', props.value === m.id && 'on')}
                  onClick={() => pick(m.id)}
                >
                  <span>{m.name}</span>
                  <span className="sub">
                    {[m.id, ctx(m.context), m.capabilities.vision && 'vision', m.capabilities.reasoning && 'reasoning', m.capabilities.tools && 'tools']
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="right">{price(m)}</span>
                  {m.tags.length > 0 && (
                    <span className="mtags">
                      {m.tags.map((t) => (
                        <TagPill key={t} tag={resolveTag(tags, t)} name={t} />
                      ))}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}

          <div className="eyebrow flex items-center gap-2">
            On this PC <Soon />
          </div>
          <div className="px-2 pb-1 text-[12px] faint">Local models (Foundry Local) are planned and not available yet.</div>

          <div className="eyebrow" style={{ paddingTop: 10 }}>
            Thinking
          </div>
          <div style={{ padding: '2px 8px 6px' }}>
            <Seg
              label="Thinking effort"
              value={effort}
              options={THINKING_LEVELS.map((e) => ({
                ...e,
                disabled: e.value !== 'off' && selected != null && !selected.capabilities.reasoning,
              }))}
              onChange={(v) => props.onSettings({ thinking: v })}
            />
            {selected && !selected.capabilities.reasoning && (
              <div className="mt-1 text-[11px] faint">{selected.name} does not support thinking.</div>
            )}
          </div>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              openSettings('models')
            }}
          >
            <span className="muted">Edit tags…</span>
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
