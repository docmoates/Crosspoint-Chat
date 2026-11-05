import * as RSwitch from '@radix-ui/react-switch'
import * as RTooltip from '@radix-ui/react-tooltip'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { cn } from '../../lib/utils'

export function Switch(props: {
  checked: boolean
  onChange?: (v: boolean) => void
  disabled?: boolean
  label: string
}): ReactElement {
  return (
    <RSwitch.Root
      className="switch"
      checked={props.checked}
      onCheckedChange={props.onChange}
      disabled={props.disabled}
      aria-label={props.label}
    >
      <RSwitch.Thumb className="switch-thumb" />
    </RSwitch.Root>
  )
}

export function Seg<T extends string>(props: {
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (v: T) => void
  label: string
  disabled?: boolean
}): ReactElement {
  return (
    <span className="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          className={cn(props.value === o.value && 'on')}
          disabled={props.disabled || o.disabled}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

export function Tip(props: { content: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }): ReactElement {
  if (props.content == null || props.content === '') return props.children
  return (
    <RTooltip.Root delayDuration={350}>
      <RTooltip.Trigger asChild>{props.children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="tooltip" side={props.side ?? 'top'} sideOffset={6}>
          {props.content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

/** Honest marker for features from the plan that are not built yet. */
export function Soon(props: { className?: string; children?: ReactNode }): ReactElement {
  return <span className={cn('soon', props.className)}>{props.children ?? 'coming soon'}</span>
}

export function Spinner(props: { size?: number }): ReactElement {
  const s = props.size ?? 12
  return <span className="spin" style={{ width: s, height: s, borderWidth: s < 10 ? 1.5 : 2 }} aria-hidden />
}

export function Empty(props: { title: string; children?: ReactNode; action?: ReactNode }): ReactElement {
  return (
    <div className="empty">
      <b>{props.title}</b>
      {props.children}
      {props.action && <div className="mt-3 flex justify-center gap-2">{props.action}</div>}
    </div>
  )
}

export function ErrorLine(props: { error: string | null | undefined }): ReactElement | null {
  if (!props.error) return null
  return (
    <div className="notice error" role="alert">
      {props.error}
    </div>
  )
}
