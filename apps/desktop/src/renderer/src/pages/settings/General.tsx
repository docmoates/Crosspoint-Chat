import { ExternalLink, FolderOpen, RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { ConfirmDialog } from '../../components/ui/dialogs'
import { ErrorLine, Seg, Soon, Spinner, Switch } from '../../components/ui/primitives'
import { api, errorText } from '../../lib/api'
import { adminUrl, relTime } from '../../lib/utils'
import type { LocalSettings, UpdateState } from '../../lib/types'
import { FONT_STACKS, useApp } from '../../store/app'
import { useConfig } from '../../store/config'
import { usePairing } from '../../store/pairing'

const FONT_SIZES = ['12', '13', '14', '15', '16', '18'] as const

export function GeneralSection(): ReactElement {
  const { settings, setSettings } = useApp()
  const models = useConfig((s) => s.models)
  const [cap, setCap] = useState(settings.dailyCapUsd != null ? String(settings.dailyCapUsd) : '')
  useEffect(() => setCap(settings.dailyCapUsd != null ? String(settings.dailyCapUsd) : ''), [settings.dailyCapUsd])

  return (
    <section>
      <h2>General</h2>
      <div>
        <div className="setting">
          <div className="grow">
            Theme<small>Follows Windows by default</small>
          </div>
          <Seg<LocalSettings['theme']>
            label="Theme"
            value={settings.theme}
            onChange={(theme) => void setSettings({ theme })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </div>
        <div className="setting">
          <div className="grow">
            Font size<small>Text size across the app</small>
          </div>
          <Seg
            label="Font size"
            value={String(settings.fontSize)}
            onChange={(v) => void setSettings({ fontSize: Number(v) })}
            options={FONT_SIZES.map((s) => ({ value: s, label: s }))}
          />
        </div>
        <div className="setting">
          <div className="grow">
            Font<small>Typeface for the interface and messages</small>
          </div>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={settings.font in FONT_STACKS ? settings.font : 'system'}
            onChange={(e) => void setSettings({ font: e.target.value })}
            aria-label="Font"
          >
            <option value="system">System</option>
            <option value="segoe">Segoe UI</option>
            <option value="serif">Serif</option>
            <option value="mono">Monospace</option>
          </select>
        </div>
        <div className="setting">
          <div className="grow">
            Send with Enter
            <small>{settings.sendOnEnter ? 'Shift+Enter inserts a new line' : 'Ctrl+Enter sends; Enter inserts a new line'}</small>
          </div>
          <Switch label="Send with Enter" checked={settings.sendOnEnter} onChange={(v) => void setSettings({ sendOnEnter: v })} />
        </div>
        <div className="setting">
          <div className="grow">
            Default model on this PC<small>Overrides the admin default for new chats</small>
          </div>
          <select
            className="input"
            style={{ width: 'auto', maxWidth: 260 }}
            value={settings.defaultModelOverride ?? ''}
            onChange={(e) => void setSettings({ defaultModelOverride: e.target.value || null })}
            aria-label="Default model"
          >
            <option value="">Use the admin default</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div className="grow">
            Daily cap on this PC<small>Optional, in USD. The monthly limit is set in admin and always applies.</small>
          </div>
          <input
            className="input mono"
            style={{ width: 110 }}
            inputMode="decimal"
            placeholder="none"
            value={cap}
            aria-label="Daily cap in USD"
            onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ''))}
            onBlur={() => {
              const n = cap === '' ? null : Number(cap)
              if (n !== settings.dailyCapUsd && (n === null || !Number.isNaN(n))) void setSettings({ dailyCapUsd: n })
            }}
          />
        </div>
        <div className="setting">
          <div className="grow">
            Data folder<small className="mono">{settings.dataFolder || 'Default location'}</small>
          </div>
          <button
            type="button"
            className="btn sm"
            disabled={!settings.dataFolder}
            onClick={() => settings.dataFolder && void api.app.openPath(settings.dataFolder)}
          >
            <FolderOpen className="ic-sm" /> Open
          </button>
        </div>
        <div className="setting">
          <div className="grow">
            Notifications<small>When background runs or scheduled tasks finish</small>
          </div>
          <Soon />
        </div>
      </div>
    </section>
  )
}

export function DeviceSection(): ReactElement {
  const { status, syncing, syncNow, unpair, busy, error } = usePairing()
  const [confirm, setConfirm] = useState(false)
  const host = status?.host
  return (
    <section>
      <h2>Device</h2>
      <ErrorLine error={error} />
      <div className="card">
        <div className="list">
          <div className="row">
            <span className={status?.paired ? (status.error ? 'sdot warn' : 'sdot ok') : 'sdot bad'} />
            <div className="grow">
              {status?.device?.name ?? 'This PC'}
              <small>
                {status?.paired
                  ? `Paired with ${host}${status.device?.id ? ` · device ${status.device.id}` : ''}`
                  : 'Not paired'}
              </small>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              Last sync
              <small>{status?.lastSyncAt ? `${relTime(status.lastSyncAt)} · ${new Date(status.lastSyncAt).toLocaleString()}` : 'Never'}</small>
            </div>
            <button type="button" className="btn sm" disabled={!status?.paired || syncing} onClick={() => void syncNow()}>
              {syncing ? <Spinner /> : <RefreshCw className="ic-sm" />} Sync now
            </button>
          </div>
          {status?.error && (
            <div className="row">
              <div className="grow" style={{ color: 'var(--warn)' }}>
                {status.error}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn sm" onClick={() => void api.app.openExternal(adminUrl(host, '/devices'))}>
          <ExternalLink className="ic-sm" /> Manage devices in admin
        </button>
        <button type="button" className="btn sm danger" disabled={!status?.paired || busy} onClick={() => setConfirm(true)}>
          Unpair this PC
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Unpair this PC?"
        description="The device token is removed from this PC. Chats stay on disk, but nothing can be sent until you pair again."
        confirmLabel="Unpair"
        danger
        onConfirm={() => unpair()}
      />
    </section>
  )
}

export function AboutSection(): ReactElement {
  const version = useApp((s) => s.version)
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = async (): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      setState(await api.updates.check())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setChecking(false)
    }
  }

  const label = (() => {
    if (!state) return 'Not checked yet'
    switch (state.status) {
      case 'idle':
      case 'not-available':
        return 'You are up to date'
      case 'disabled':
        return 'Updates are turned off in this build'
      case 'checking':
        return 'Checking…'
      case 'available':
        return `Version ${state.version ?? ''} is available and downloading`
      case 'downloading':
        return `Downloading ${state.version ?? ''}${state.progress != null ? ` · ${Math.round(state.progress)}%` : ''}`
      case 'downloaded':
        return `Version ${state.version ?? ''} is ready to install`
      case 'error':
        return state.error ?? 'Update check failed'
    }
  })()

  return (
    <section>
      <h2>About and updates</h2>
      <div>
        <div className="setting">
          <div className="grow">
            Crosspoint Chat<small>Version {version || 'unknown'}</small>
          </div>
        </div>
        <div className="setting">
          <div className="grow">
            Updates<small>{label}</small>
          </div>
          <button type="button" className="btn sm" disabled={checking} onClick={() => void check()}>
            {checking ? <Spinner /> : <RefreshCw className="ic-sm" />} Check for updates
          </button>
          {state?.status === 'downloaded' && (
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void api.updates.install().catch((err) => setError(errorText(err)))}
            >
              Install and restart
            </button>
          )}
        </div>
      </div>
      <ErrorLine error={error} />
    </section>
  )
}
