import * as Popover from '@radix-ui/react-popover'
import { useState, type ReactElement } from 'react'
import { api, errorText } from '../lib/api'
import { num, perM, usd } from '../lib/utils'
import type { UsageDetail, UsageInfo } from '../lib/types'
import { Spinner } from './ui/primitives'

export function usageLine(u: UsageInfo | undefined): string {
  if (!u) return ''
  const parts = [`${num(u.tokensIn)} in`, `${num(u.tokensOut)} out`]
  if (u.cachedTokens && u.tokensIn) parts.push(`${Math.round((u.cachedTokens / u.tokensIn) * 100)}% cached`)
  parts.push(u.costUsd === 0 ? 'free' : usd(u.costUsd))
  return parts.join(' · ')
}

function Explain(props: { d: UsageDetail }): ReactElement {
  const { d } = props
  const pricing = d.pricing
  const pin = pricing?.in ?? null
  const pout = pricing?.out ?? null
  const uncached = Math.max(0, d.tokensIn - d.cachedTokens)
  const rows: { label: string; value: string }[] = [
    { label: 'Input tokens', value: num(d.tokensIn) },
  ]
  if (d.cachedTokens) rows.push({ label: '  of which cached', value: num(d.cachedTokens) })
  rows.push({ label: 'Output tokens', value: num(d.tokensOut) })
  if (pin != null || pout != null) rows.push({ label: 'List price per 1M (in / out)', value: `$${perM(pin)} / $${perM(pout)}` })

  const math: string[] = []
  if (pin != null && pout != null) {
    math.push(`${num(uncached)} input × $${perM(pin)}/M = ${usd((uncached * pin) / 1e6, 4)}`)
    math.push(`${num(d.tokensOut)} output × $${perM(pout)}/M = ${usd((d.tokensOut * pout) / 1e6, 4)}`)
    if (d.cachedTokens) math.push(`${num(d.cachedTokens)} cached input billed at the provider's lower cache rate`)
  }

  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="muted" style={{ padding: '4px 8px', whiteSpace: 'pre' }}>
                {r.label}
              </td>
              <td style={{ padding: '4px 8px', textAlign: 'right' }}>{r.value}</td>
            </tr>
          ))}
          <tr>
            <td style={{ padding: '4px 8px', fontWeight: 600 }}>Charged</td>
            <td style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>{usd(d.costUsd, 4)}</td>
          </tr>
        </tbody>
      </table>
      {math.length > 0 && (
        <div className="faint mono flex flex-col gap-0.5 text-[11px]">
          {math.map((m) => (
            <span key={m}>{m}</span>
          ))}
          <span>The charged amount is what the provider reported; list prices are from the catalog.</span>
        </div>
      )}
      <div className="faint text-[11px]">
        {d.kind} · {new Date(d.at).toLocaleString()}
      </div>
    </div>
  )
}

export function UsagePopover(props: {
  messageId: string | undefined
  usage: UsageInfo | undefined
}): ReactElement | null {
  const [detail, setDetail] = useState<UsageDetail | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const line = usageLine(props.usage)
  if (!line) return null
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open || !props.messageId) return
        setError(null)
        setDetail(undefined)
        api.usage
          .forMessage(props.messageId)
          .then(setDetail)
          .catch((err) => setError(errorText(err)))
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className="cost" title="Why did this cost that?">
          {line}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu" style={{ width: 360, padding: 12 }} side="top" align="start" sideOffset={6}>
          <h4 className="mb-2 text-[13px]">Why did this cost that?</h4>
          {!props.messageId && <div className="muted text-[12.5px]">Details are ready once the answer is saved.</div>}
          {props.messageId && detail === undefined && !error && (
            <div className="status-row">
              <Spinner /> Loading usage…
            </div>
          )}
          {error && <div className="notice error">{error}</div>}
          {detail === null && <div className="muted text-[12.5px]">No usage was recorded for this message.</div>}
          {detail && <Explain d={detail} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
