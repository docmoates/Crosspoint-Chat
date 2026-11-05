import { ExternalLink, Link2 } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { ErrorLine, Spinner } from '../components/ui/primitives'
import { api } from '../lib/api'
import { ADMIN_HOST_DEFAULT, adminUrl } from '../lib/utils'
import { usePairing } from '../store/pairing'

/** Formats user input as XXXX-XXXX (letters and digits only). */
export function formatCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

export function PairingPage(): ReactElement {
  const { status, busy, error, pair, clearError } = usePairing()
  const [code, setCode] = useState('')
  const [host, setHost] = useState(status?.host || ADMIN_HOST_DEFAULT)
  const [showHost, setShowHost] = useState(false)

  useEffect(() => {
    if (status?.host) setHost(status.host)
  }, [status?.host])

  const valid = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)
  const shownError = error ?? status?.error

  return (
    <div className="pair-wrap">
      <form
        className="pair-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && !busy) void pair(code, host.trim() || undefined)
        }}
      >
        <div className="brand" style={{ flex: 'none', fontSize: 18 }}>
          <span className="logo" style={{ width: 30, height: 30, fontSize: 14, borderRadius: 8 }}>
            X
          </span>
          Crosspoint Chat
        </div>
        <div>
          <h1 style={{ fontSize: 22 }}>Pair this PC</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Your messages go through your admin site. Create a pairing code there, then enter it here. You only do
            this once.
          </p>
        </div>
        <div className="card flex flex-col gap-3">
          <label className="f">
            Pairing code
            <input
              className="input code-input"
              value={code}
              onChange={(e) => {
                setCode(formatCode(e.target.value))
                if (error) clearError()
              }}
              placeholder="XXXX-XXXX"
              autoFocus
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={code.length === 9 && !valid}
            />
          </label>
          {showHost ? (
            <label className="f">
              Admin host
              <input
                className="input"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={ADMIN_HOST_DEFAULT}
                spellCheck={false}
              />
            </label>
          ) : (
            <div className="text-[12px] faint">
              Pairing with <span className="mono">{host}</span> ·{' '}
              <button type="button" className="underline" onClick={() => setShowHost(true)}>
                change
              </button>
            </div>
          )}
          <ErrorLine error={shownError} />
          <button type="submit" className="btn primary justify-center" disabled={!valid || busy}>
            {busy ? <Spinner /> : <Link2 className="ic-sm" />}
            {busy ? 'Pairing…' : 'Pair'}
          </button>
        </div>
        <button
          type="button"
          className="btn self-start"
          onClick={() => void api.app.openExternal(adminUrl(host, '/devices'))}
        >
          <ExternalLink className="ic-sm" /> Open {host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/devices
        </button>
        <p className="faint text-[12px]" style={{ margin: 0 }}>
          A <span className="mono">crosspoint://pair</span> link from the admin site also pairs this PC automatically.
        </p>
      </form>
    </div>
  )
}
