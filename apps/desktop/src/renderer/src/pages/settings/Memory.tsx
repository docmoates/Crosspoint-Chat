import { Plus } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { Empty, ErrorLine, Spinner } from '../../components/ui/primitives'
import { api, errorText } from '../../lib/api'
import { relTime } from '../../lib/utils'
import type { Memory } from '../../lib/types'

export function MemorySection(): ReactElement {
  const [items, setItems] = useState<Memory[] | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    api.memories
      .list()
      .then(setItems)
      .catch((err) => setError(errorText(err)))
  }, [])

  const add = async (): Promise<void> => {
    const t = text.trim()
    if (!t) return
    setAdding(true)
    try {
      const m = await api.memories.add(t)
      setItems((x) => [m, ...(x ?? [])])
      setText('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setAdding(false)
    }
  }

  const forget = async (id: string): Promise<void> => {
    try {
      await api.memories.remove(id)
      setItems((x) => x?.filter((m) => m.id !== id) ?? null)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section>
      <h2>Memory</h2>
      <p className="muted" style={{ margin: 0 }}>
        Facts the assistant remembers across chats. Add your own or forget any of them.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input
          className="input"
          placeholder="e.g. I teach psychology and prefer APA 7 citations"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="New memory"
        />
        <button type="submit" className="btn sm primary" disabled={!text.trim() || adding}>
          {adding ? <Spinner /> : <Plus className="ic-sm" />} Remember
        </button>
      </form>
      <ErrorLine error={error} />
      {items === null && !error && (
        <div className="status-row">
          <Spinner /> Loading memories…
        </div>
      )}
      {items && items.length === 0 && <Empty title="Nothing remembered yet">Add a fact above and it is used in every chat.</Empty>}
      {items && items.length > 0 && (
        <div className="card">
          <div className="list">
            {items.map((m) => (
              <div className="row" key={m.id}>
                <div className="grow">
                  <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
                  <small>
                    {m.source === 'user' ? 'Saved by you' : 'Learned from a chat'} · {relTime(m.createdAt)}
                  </small>
                </div>
                <button type="button" className="btn sm danger" onClick={() => void forget(m.id)}>
                  Forget
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
