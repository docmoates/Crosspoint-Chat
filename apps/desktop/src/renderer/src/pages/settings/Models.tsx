import { ExternalLink, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState, type ReactElement } from 'react'
import { modelName, price } from '../../components/ModelPicker'
import { ErrorLine, Soon, Spinner, TagPill } from '../../components/ui/primitives'
import { api } from '../../lib/api'
import { adminUrl, cn, ctx, TAG_PALETTE, uid } from '../../lib/utils'
import { defaultChatModel, providerLabel, resolveTag, useConfig } from '../../store/config'
import { usePairing } from '../../store/pairing'

const PAGE = 60

export function ModelsSection(): ReactElement {
  const { config, models, tags, refreshing, error, refreshModels, saveTag, removeTag, setModelTags } = useConfig()
  const host = usePairing((s) => s.status?.host)
  const [name, setName] = useState('')
  const [color, setColor] = useState(TAG_PALETTE[0] as string)
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return models.filter((m) => !n || `${m.name} ${m.id} ${m.provider} ${m.tags.join(' ')}`.toLowerCase().includes(n))
  }, [models, q])

  const addTag = (): void => {
    const n = name.trim()
    if (!n || tags.some((t) => t.name.toLowerCase() === n.toLowerCase())) return
    void saveTag({ id: uid('tag'), name: n, color })
    setName('')
  }

  const chatDefault = defaultChatModel(config)
  const helperDefault = config?.default_models.helper ?? null

  return (
    <section>
      <h2>Models</h2>
      <div>
        <div className="setting">
          <div className="grow">
            Default chat model<small>Set in admin</small>
          </div>
          <span className="pill">{chatDefault ? modelName(models, chatDefault) : 'Not set'}</span>
        </div>
        <div className="setting">
          <div className="grow">
            Helper model<small>Background work such as titles and summaries · set in admin</small>
          </div>
          <span className="pill">{helperDefault ? modelName(models, helperDefault) : 'Not set'}</span>
        </div>
        <div className="setting">
          <div className="grow">
            Model catalog
            <small>
              {models.length} models available
              {config && config.allowed_models.length > 0 ? ` · limited to ${config.allowed_models.length} allowed in admin` : ''}
            </small>
          </div>
          <button type="button" className="btn sm" disabled={refreshing} onClick={() => void refreshModels()}>
            {refreshing ? <Spinner /> : <RefreshCw className="ic-sm" />} Refresh
          </button>
          <button type="button" className="btn sm" onClick={() => void api.app.openExternal(adminUrl(host, '/chat-settings'))}>
            <ExternalLink className="ic-sm" /> Edit in admin
          </button>
        </div>
        <div className="setting">
          <div className="grow">
            Auto routing between local and cloud<small>Picks a local or cloud model per message</small>
          </div>
          <Soon />
        </div>
      </div>
      <ErrorLine error={error} />

      <div className="card">
        <h3>
          Your tags <span className="tag">you decide the tags; they filter the model picker</span>
        </h3>
        <div className="tagedit" style={{ marginBottom: 10 }}>
          {tags.length === 0 && <span className="faint text-[12.5px]">No tags yet. Add one below, e.g. coding, cheap or vision.</span>}
          {tags.map((t) => (
            <TagPill key={t.id} tag={t} onClick={() => void removeTag(t.id)} title={`Remove tag ${t.name}`} />
          ))}
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            addTag()
          }}
        >
          <input
            className="input"
            style={{ width: 180 }}
            placeholder="New tag, e.g. writing"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="New tag name"
          />
          <span className="swatches" role="radiogroup" aria-label="Tag color">
            {TAG_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                className={cn(c === color && 'on')}
                style={{ background: c }}
                title="Tag color"
                onClick={() => setColor(c)}
              />
            ))}
          </span>
          <button type="submit" className="btn sm primary" disabled={!name.trim()}>
            Add tag
          </button>
        </form>
      </div>

      <div className="card">
        <h3>
          Tags per model <span className="tag">click a tag to remove it</span>
        </h3>
        <div className="mb-2 flex items-center gap-2">
          <Search className="ic-sm faint" />
          <input
            className="input"
            placeholder="Filter models"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setLimit(PAGE)
            }}
            aria-label="Filter models"
          />
        </div>
        {models.length === 0 ? (
          <div className="muted text-[13px]">No models yet. The catalog arrives after pairing and sync.</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Price / 1M</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, limit).map((m) => {
                  const available = tags.filter((t) => !m.tags.some((x) => x === t.id || x.toLowerCase() === t.name.toLowerCase()))
                  return (
                    <tr key={m.id}>
                      <td>
                        {m.name}
                        <div className="faint text-[11px]">
                          {m.id}
                          {m.context ? ` · ${ctx(m.context)}` : ''}
                        </div>
                      </td>
                      <td className="muted">{providerLabel(config, m.provider)}</td>
                      <td className="mono text-[12px]">{price(m)}</td>
                      <td>
                        <div className="tagedit">
                          {m.tags.map((ref) => (
                            <TagPill
                              key={ref}
                              tag={resolveTag(tags, ref)}
                              name={ref}
                              title="Remove"
                              onClick={() => void setModelTags(m.id, m.tags.filter((x) => x !== ref))}
                            />
                          ))}
                          {available.length > 0 && (
                            <select
                              value=""
                              aria-label={`Add tag to ${m.name}`}
                              onChange={(e) => {
                                if (e.target.value) void setModelTags(m.id, [...m.tags, e.target.value])
                              }}
                            >
                              <option value="">+ tag</option>
                              {available.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {filtered.length > limit && (
              <button type="button" className="btn sm mt-2" onClick={() => setLimit((l) => l + PAGE)}>
                Show more ({filtered.length - limit} left)
              </button>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h3>
          Image models <Soon />
        </h3>
        <div className="muted text-[13px]">
          Local and cloud image generation with settings chosen by the chat model. Models tagged "images" will appear on the
          image card.
        </div>
      </div>
    </section>
  )
}
