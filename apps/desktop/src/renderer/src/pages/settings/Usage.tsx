import { RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { ErrorLine, Spinner } from '../../components/ui/primitives'
import { api, errorText } from '../../lib/api'
import { usd } from '../../lib/utils'
import type { UsageSummary } from '../../lib/types'
import { useApp } from '../../store/app'
import { useConfig } from '../../store/config'

export function UsageSection(): ReactElement {
  const [data, setData] = useState<UsageSummary | null>(useApp.getState().usage)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const config = useConfig((s) => s.config)
  const dailyCapLocal = useApp((s) => s.settings.dailyCapUsd)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const s = await api.usage.summary()
      setData(s)
      useApp.setState({ usage: s })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const monthly = config?.limits.monthly_usd ?? null
  const daily = config?.limits.daily_usd ?? null
  const allDevicesMonth = config?.spend.month_usd ?? null
  const days = data?.byDay ?? []
  const max = Math.max(0.0001, ...days.map((d) => d.usd))

  return (
    <section>
      <div className="flex items-center gap-3">
        <h2 className="flex-1">Usage</h2>
        <button type="button" className="btn sm" disabled={loading} onClick={() => void load()}>
          {loading ? <Spinner /> : <RefreshCw className="ic-sm" />} Refresh
        </button>
      </div>
      <ErrorLine error={error} />
      <div className="grid2">
        <div className="card">
          <div className="eyebrow">This month</div>
          <div className="mono" style={{ fontSize: 24, fontWeight: 600 }}>
            {data ? usd(data.month_usd, 2) : '—'}
          </div>
          <div className="faint text-[12px]">
            {monthly != null ? `of ${usd(monthly, 2)} monthly limit (admin)` : 'No monthly limit set in admin'}
            {allDevicesMonth != null && ` · ${usd(allDevicesMonth, 2)} across all devices`}
          </div>
          {monthly != null && data && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div
                className="h-full"
                style={{
                  width: `${Math.min(100, (data.month_usd / monthly) * 100)}%`,
                  background: data.month_usd > monthly * 0.9 ? 'var(--warn)' : 'var(--accent)',
                }}
              />
            </div>
          )}
        </div>
        <div className="card">
          <div className="eyebrow">Today</div>
          <div className="mono" style={{ fontSize: 24, fontWeight: 600 }}>
            {data ? usd(data.today_usd, 2) : '—'}
          </div>
          <div className="faint text-[12px]">
            {daily != null ? `Daily limit ${usd(daily, 2)} (admin)` : 'No daily limit in admin'}
            {dailyCapLocal != null && ` · cap on this PC ${usd(dailyCapLocal, 2)}`}
            {data && data.local_share > 0 && ` · ${Math.round(data.local_share * 100)}% answered locally`}
          </div>
        </div>
      </div>
      <div className="card">
        <h3>By day</h3>
        {days.length === 0 ? (
          <div className="muted text-[13px]">No spend recorded yet. Costs appear here after your first message.</div>
        ) : (
          <>
            <div className="bars" role="img" aria-label="Spend by day">
              {days.map((d) => (
                <div key={d.day} title={`${d.day}: ${usd(d.usd, 3)}`} style={{ height: `${Math.max(1, (d.usd / max) * 100)}%` }} />
              ))}
            </div>
            <div className="faint mt-1 flex justify-between text-[11px]">
              <span>{days[0]?.day}</span>
              <span>max {usd(max, 2)}</span>
              <span>{days[days.length - 1]?.day}</span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
