import * as Popover from '@radix-ui/react-popover'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import type { ChatSettings } from '../lib/types'
import { THINKING_LEVELS } from './ModelPicker'
import { Seg } from './ui/primitives'

/** Per-chat overrides, saved through conversations.update (or kept as a draft until the chat exists). */
export function ChatSettingsPopover(props: {
  settings: ChatSettings | undefined
  onChange: (patch: Partial<ChatSettings>) => void
  supportsThinking: boolean
}): ReactElement {
  const s = props.settings ?? {}
  const [system, setSystem] = useState(s.systemPrompt ?? '')
  const [temp, setTemp] = useState<number | undefined>(s.temperature)
  const [maxTokens, setMaxTokens] = useState(s.maxTokens != null ? String(s.maxTokens) : '')
  useEffect(() => setSystem(s.systemPrompt ?? ''), [s.systemPrompt])
  useEffect(() => setTemp(s.temperature), [s.temperature])
  useEffect(() => setMaxTokens(s.maxTokens != null ? String(s.maxTokens) : ''), [s.maxTokens])
  const thinking = s.thinking ?? 'off'
  const active = Boolean(s.systemPrompt) || s.temperature != null || s.maxTokens != null || thinking !== 'off'

  const commitTemp = (): void => {
    if (temp != null && temp !== s.temperature) props.onChange({ temperature: temp })
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={active ? 'pill on' : 'pill'} title="Chat settings">
          <SlidersHorizontal className="ic-xs" />
          <span className="desk-only">Settings</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu" style={{ width: 380, padding: 14 }} side="top" align="start" sideOffset={6}>
          <div className="flex flex-col gap-3">
            <div className="eyebrow" style={{ padding: 0 }}>
              This chat
            </div>
            <label className="f">
              System prompt
              <textarea
                className="input"
                value={system}
                placeholder="Optional instructions for this chat only"
                onChange={(e) => setSystem(e.target.value)}
                onBlur={() => {
                  if (system !== (s.systemPrompt ?? '')) props.onChange({ systemPrompt: system || undefined })
                }}
              />
            </label>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-[12px] muted">
                Temperature
                <span className="ml-auto mono">{temp == null ? 'model default' : temp.toFixed(1)}</span>
                {temp != null && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setTemp(undefined)
                      props.onChange({ temperature: undefined })
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temp ?? 1}
                aria-label="Temperature"
                onChange={(e) => setTemp(Number(e.target.value))}
                onPointerUp={commitTemp}
                onKeyUp={commitTemp}
                style={{ accentColor: 'var(--accent)' }}
              />
            </div>
            <label className="f">
              Max output tokens
              <input
                className="input mono"
                inputMode="numeric"
                placeholder="model default"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value.replace(/\D/g, ''))}
                onBlur={() => {
                  const n = maxTokens ? Number(maxTokens) : undefined
                  if (n !== s.maxTokens) props.onChange({ maxTokens: n && n > 0 ? Math.min(n, 200_000) : undefined })
                }}
              />
            </label>
            <div className="flex items-center gap-2 text-[12px] muted">
              <span className="flex-1">
                Extended thinking
                {!props.supportsThinking && <span className="faint"> · not supported by this model</span>}
              </span>
              <Seg
                label="Extended thinking"
                value={thinking}
                disabled={!props.supportsThinking}
                options={THINKING_LEVELS}
                onChange={(v) => props.onChange({ thinking: v })}
              />
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
