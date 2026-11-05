import { ChevronRight, ExternalLink } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { api } from '../lib/api'
import type { KnowledgeCard } from '../lib/types'

const VISIBLE_FACTS = 6

function Facts(props: { facts: KnowledgeCard['facts'] }): ReactElement {
  return (
    <dl className="kc-facts">
      {props.facts.map((f) => (
        <div key={f.label} className="kc-fact">
          <dt>{f.label}</dt>
          <dd>
            {f.href ? (
              <a
                href={f.href}
                onClick={(e) => {
                  e.preventDefault()
                  void api.app.openExternal(f.href as string)
                }}
              >
                {f.value}
              </a>
            ) : (
              f.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function SourceLink(props: { url: string; children: string }): ReactElement {
  return (
    <button type="button" className="kc-link" onClick={() => void api.app.openExternal(props.url)}>
      {props.children} <ExternalLink className="ic-xs" />
    </button>
  )
}

/** A Google-style panel for the entity a question is about: Wikipedia summary on top, Wikidata facts below. */
export function KnowledgeCardView(props: { card: KnowledgeCard }): ReactElement {
  const { card } = props
  const [more, setMore] = useState(false)
  const shown = card.facts.slice(0, VISIBLE_FACTS)
  const rest = card.facts.slice(VISIBLE_FACTS)
  return (
    <aside className="kcard" aria-label={`About ${card.title}`}>
      <div className="kc-head">
        <div className="kc-title">
          <h3>{card.title}</h3>
          {card.description && <div className="kc-desc">{card.description}</div>}
        </div>
        {card.thumbnail && <img className="kc-thumb" src={card.thumbnail} alt="" />}
      </div>
      <p className={more ? 'kc-extract open' : 'kc-extract'}>{card.extract}</p>
      {card.extract.length > 260 && (
        <button type="button" className="kc-more" onClick={() => setMore((v) => !v)}>
          {more ? 'Show less' : 'Read more'}
        </button>
      )}
      {shown.length > 0 && <Facts facts={shown} />}
      {rest.length > 0 && (
        <details className="activity kc-rest">
          <summary>
            <span>More facts ({rest.length})</span>
            <ChevronRight className="chev ic-sm" />
          </summary>
          <Facts facts={rest} />
        </details>
      )}
      <div className="kc-foot">
        <SourceLink url={card.wikipediaUrl}>Wikipedia</SourceLink>
        {card.wikidataUrl && <SourceLink url={card.wikidataUrl}>Wikidata</SourceLink>}
        <span className="faint">Text from Wikipedia, CC BY-SA 4.0</span>
      </div>
    </aside>
  )
}
