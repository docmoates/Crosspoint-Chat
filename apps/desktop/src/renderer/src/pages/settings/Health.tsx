import { Activity } from 'lucide-react'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { ErrorLine, Spinner } from '../../components/ui/primitives'
import { api, errorText } from '../../lib/api'
import { adminUrl, bytes, relTime } from '../../lib/utils'
import type { HealthReport } from '../../lib/types'
import { useApp } from '../../store/app'
import { usePairing } from '../../store/pairing'

interface Row {
  id: string
  label: string
  status: 'ok' | 'warn' | 'bad' | 'off'
  detail: string
  fix?: string
  action?: ReactNode
}

const LOW_DISK = 2 * 1024 * 1024 * 1024

export function HealthSection(): ReactElement {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openSettings = useApp((s) => s.openSettings)
  const syncNow = usePairing((s) => s.syncNow)
  const host = usePairing((s) => s.status?.host)

  const run = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      setReport(await api.health.check())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    void run()
  }, [])

  const rows: Row[] = []
  if (report) {
    const a = report.admin
    rows.push({
      id: 'admin',
      label: 'Admin sync',
      status: a.ok ? 'ok' : 'bad',
      detail: a.ok
        ? `${a.paired ? 'Paired' : 'Not paired'} · ${a.host}${a.latencyMs != null ? ` · ${a.latencyMs} ms` : ''}`
        : `${a.host} · ${a.error ?? 'unreachable'}`,
      fix: a.ok
        ? undefined
        : a.paired
          ? 'Check the internet connection, then sync. Cached config keeps working meanwhile. If admin revoked this PC, pair again.'
          : 'Pair this PC from the Device page.',
      action: a.ok ? undefined : a.paired ? (
        <button type="button" className="btn sm" onClick={() => void syncNow().then(run)}>
          Sync now
        </button>
      ) : (
        <button type="button" className="btn sm" onClick={() => openSettings('device')}>
          Device
        </button>
      ),
    })
    if (report.providers.length === 0) {
      rows.push({
        id: 'providers',
        label: 'Cloud providers',
        status: 'warn',
        detail: 'No providers configured',
        fix: 'Add a provider key in admin, then sync.',
        action: (
          <button type="button" className="btn sm" onClick={() => void api.app.openExternal(adminUrl(host, '/integrations'))}>
            Open admin
          </button>
        ),
      })
    }
    for (const p of report.providers) {
      rows.push({
        id: `provider:${p.id}`,
        label: p.label,
        status: p.ok ? 'ok' : 'bad',
        detail: p.ok ? `${p.kind}${p.latencyMs != null ? ` · ${p.latencyMs} ms` : ''}` : `${p.kind} · ${p.error ?? 'failed'}`,
        fix: p.ok
          ? undefined
          : /401|403|key|auth/i.test(p.error ?? '')
            ? 'The key was rejected. Replace it in admin, then sync.'
            : 'Check the base URL in admin and that the service is up. Other providers still work.',
        action: p.ok ? undefined : (
          <button
            type="button"
            className="btn sm"
            onClick={() => void api.app.openExternal(adminUrl(host, p.id.startsWith('custom:') ? '/endpoints' : '/integrations'))}
          >
            Edit in admin
          </button>
        ),
      })
    }
    rows.push({
      id: 'db',
      label: 'Database',
      status: report.db.ok ? 'ok' : 'bad',
      detail: `${report.db.path}${report.db.sizeBytes != null ? ` · ${bytes(report.db.sizeBytes)}` : ''}${report.db.error ? ` · ${report.db.error}` : ''}`,
      fix: report.db.ok ? undefined : 'Restart the app. If it stays red, the database file may be damaged; restore it from a backup in the data folder.',
      action: report.db.ok ? undefined : (
        <button type="button" className="btn sm" onClick={() => void api.app.openPath(report.db.path)}>
          Open folder
        </button>
      ),
    })
    const free = report.disk.freeBytes
    const low = free != null && free < LOW_DISK
    rows.push({
      id: 'disk',
      label: 'Disk',
      status: !report.disk.ok ? 'bad' : low ? 'warn' : 'ok',
      detail: `${free != null ? `${bytes(free)} free` : 'free space unknown'} · ${report.disk.path}${report.disk.error ? ` · ${report.disk.error}` : ''}`,
      fix: !report.disk.ok || low ? 'Free some space on this drive. Chats and attachments need room to save.' : undefined,
    })
    const u = report.update
    const uBad = u.status === 'error'
    rows.push({
      id: 'update',
      label: 'Updates',
      status: uBad ? 'warn' : u.status === 'disabled' ? 'off' : 'ok',
      detail:
        u.status === 'downloaded'
          ? `Version ${u.version ?? ''} ready to install`
          : u.status === 'available' || u.status === 'downloading'
            ? `Downloading ${u.version ?? ''}`
            : u.status === 'disabled'
              ? 'Turned off in this build'
              : uBad
                ? (u.error ?? 'Update check failed')
                : 'Up to date',
      fix: uBad ? 'Check again from About. Updates also install on their own when you close the app.' : undefined,
      action:
        uBad || u.status === 'downloaded' ? (
          <button type="button" className="btn sm" onClick={() => openSettings('about')}>
            Updates
          </button>
        ) : undefined,
    })
  }
  const allOk = rows.every((r) => r.status === 'ok' || r.status === 'off')

  return (
    <section>
      <div className="flex items-center gap-3">
        <h2 className="flex-1">Health</h2>
        <button type="button" className="btn sm primary" disabled={running} onClick={() => void run()}>
          {running ? <Spinner /> : <Activity className="ic-sm" />} Check
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Everything runs on its own; this is the one place to look if something is off.
      </p>
      <ErrorLine error={error} />
      {report && (
        <div className="card">
          <h3>
            {allOk ? 'All good' : 'Needs attention'}
            <span className="tag">checked {relTime(report.checkedAt)}</span>
          </h3>
          <div className="list text-[13px]">
            {rows.map((r) => (
              <div className="row" key={r.id} style={{ alignItems: 'flex-start' }}>
                <span className={`sdot ${r.status}`} style={{ marginTop: 6 }} />
                <div className="grow">
                  {r.label}
                  <small style={{ whiteSpace: 'normal' }}>{r.detail}</small>
                  {r.fix && (
                    <small style={{ whiteSpace: 'normal', color: 'var(--fg-2)', marginTop: 4 }}>
                      <b style={{ fontWeight: 600 }}>Fix: </b>
                      {r.fix}
                    </small>
                  )}
                </div>
                {r.action}
              </div>
            ))}
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className="sdot off" style={{ marginTop: 6 }} />
              <div className="grow">
                Local models
                <small>Foundry Local runtime · coming soon</small>
              </div>
            </div>
          </div>
        </div>
      )}
      {!report && running && (
        <div className="status-row">
          <Spinner /> Checking admin, providers, database and disk…
        </div>
      )}
    </section>
  )
}
