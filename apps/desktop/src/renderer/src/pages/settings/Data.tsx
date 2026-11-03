import { FolderOpen } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { ErrorLine, Soon, Spinner } from '../../components/ui/primitives'
import { api, errorText } from '../../lib/api'
import type { AuditEntry } from '../../lib/types'
import { useApp } from '../../store/app'

const PAGE = 50

export function DataSection(): ReactElement {
  const dataFolder = useApp((s) => s.settings.dataFolder)
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (before?: string): Promise<void> => {
    setLoading(true)
    try {
      const page = await api.audit.list({ limit: PAGE, before })
      setEntries((e) => (before ? [...(e ?? []), ...page] : page))
      setMore(page.length === PAGE)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <section>
      <h2>Data</h2>
      <div>
        <div className="setting">
          <div className="grow">
            Data folder<small className="mono">{dataFolder || 'Default location'}</small>
          </div>
          <button type="button" className="btn sm" disabled={!dataFolder} onClick={() => dataFolder && void api.app.openPath(dataFolder)}>
            <FolderOpen className="ic-sm" /> Open
          </button>
        </div>
        <div className="setting">
          <div className="grow">
            Export all chats<small>Markdown + JSON, with attachments</small>
          </div>
          <Soon />
        </div>
        <div className="setting">
          <div className="grow">
            Import<small>From ChatGPT or Claude export zip</small>
          </div>
          <Soon />
        </div>
      </div>
      <div className="card">
        <h3>
          Audit log <span className="tag">hash-chained · a summary is sent to admin</span>
        </h3>
        <ErrorLine error={error} />
        {entries === null && !error && (
          <div className="status-row">
            <Spinner /> Loading…
          </div>
        )}
        {entries && entries.length === 0 && <div className="muted text-[13px]">Nothing logged yet.</div>}
        {entries && entries.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="faint whitespace-nowrap text-[12px]">{new Date(e.at).toLocaleString()}</td>
                    <td className="mono text-[12px]">{e.kind}</td>
                    <td className="muted text-[12.5px]" style={{ overflowWrap: 'anywhere' }} title={`hash ${e.hash}`}>
                      {e.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && (
          <button
            type="button"
            className="btn sm mt-2"
            disabled={loading}
            onClick={() => void load(entries?.[entries.length - 1]?.at)}
          >
            {loading ? <Spinner /> : null} Load older
          </button>
        )}
      </div>
    </section>
  )
}
