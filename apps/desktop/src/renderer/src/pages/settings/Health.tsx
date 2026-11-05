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
      fix: a.ok && a.paired ? undefined : a.fix,
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
    rows.push({
      id: 'db',
      label: 'Database',
      status: report.db.ok ? 'ok' : 'bad',
      detail: `${report.db.path}${report.db.sizeBytes != null ? ` · ${bytes(report.db.sizeBytes)}` : ''}${report.db.error ? ` · ${report.db.error}` : ''}`,
      fix: report.db.fix,
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
      fix: report.disk.fix,
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
      fix: u.fix,
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
          </div>
        </div>
      )}
      {!report && running && (
        <div className="status-row">
          <Spinner /> Checking the server, database and disk…
        </div>
      )}
    </section>
  )
}
