import { ExternalLink, Info, KeyRound } from 'lucide-react'
import type { ReactElement } from 'react'
import { ErrorLine, Spinner } from '../../components/ui/primitives'
import { api } from '../../lib/api'
import { adminUrl, usd } from '../../lib/utils'
import { useApp } from '../../store/app'
import { useConfig } from '../../store/config'
import { usePairing } from '../../store/pairing'

export function ProvidersSection(): ReactElement {
  const { config, loading, error } = useConfig()
  const host = usePairing((s) => s.status?.host)
  const usage = useApp((s) => s.usage)
  const open = (path: string): void => void api.app.openExternal(adminUrl(host, path))
  const monthlyLimit = config?.limits.monthly_usd ?? null

  return (
    <section>
      <h2>Providers</h2>
      <div className="note">
        <Info className="ic-sm" style={{ marginTop: 2 }} />
        <div>
          API keys, spend limits and allowed models are managed in{' '}
          <button type="button" className="link" onClick={() => open('/chat-settings')}>
            {(host ?? 'admin').replace(/^https?:\/\//, '')}
          </button>
          . This page is read-only and updates after each sync.
        </div>
      </div>
      <ErrorLine error={error} />
      {loading && !config && (
        <div className="status-row">
          <Spinner /> Loading config…
        </div>
      )}
      {config && (
        <div className="card">
          <div className="list">
            {config.providers.length === 0 && (
              <div className="row muted">No providers yet. Add one in admin, then sync.</div>
            )}
            {config.providers.map((p) => (
              <div className="row" key={p.id}>
                <span className={!p.enabled ? 'sdot off' : p.hasKey ? 'sdot ok' : 'sdot warn'} />
                <div className="grow">
                  {p.label}
                  <small>
                    {[p.kind, p.base_url, !p.enabled && 'disabled in admin'].filter(Boolean).join(' · ')}
                  </small>
                </div>
                <span className="tag" title={p.hasKey ? 'A key is stored in admin' : 'No key in admin'}>
                  <KeyRound className="ic-xs inline" style={{ verticalAlign: -2 }} /> {p.hasKey ? 'key present' : 'no key'}
                </span>
                <button type="button" className="btn sm" onClick={() => open(p.id.startsWith('custom:') ? '/endpoints' : '/integrations')}>
                  <ExternalLink className="ic-sm" /> Edit in admin
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="setting">
        <div className="grow">
          Monthly spend<small>{monthlyLimit != null ? `Limit set in admin: ${usd(monthlyLimit, 2)}` : 'No monthly limit reported by admin'}</small>
        </div>
        <span className="mono">{usage ? usd(usage.month_usd, 2) : '—'}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn sm" onClick={() => open('/chat-settings')}>
          <ExternalLink className="ic-sm" /> Allowed models and limits
        </button>
        <button type="button" className="btn sm" onClick={() => open('/endpoints')}>
          <ExternalLink className="ic-sm" /> Custom endpoints
        </button>
      </div>
      {config && <div className="faint text-[11px]">Config version {String(config.config_version)}</div>}
    </section>
  )
}
