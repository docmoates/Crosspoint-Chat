import { ChevronRight, ExternalLink } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { api } from '../lib/api'
import type { KnowledgeCard } from '../lib/types'

const VISIBLE_FACTS = 12

/** Sections in display order. Facts not listed here go under Details. */
const SECTIONS: [string, string[]][] = [
  ['Personal', ['Born', 'Died', 'Citizenship', 'Residence', 'Languages', 'Also known as']],
  ['Education', ['Education', 'Degree', 'Field of study', 'Doctoral advisor']],
  ['Career', ['Occupation', 'Employer', 'Field of work', 'Position held', 'Member of', 'Movement', 'Founder', 'CEO', 'Industry', 'Notable work']],
  ['Recognition', ['Awards']],
  ['Online', ['Website', 'X (Twitter)', 'Instagram', 'Facebook', 'ORCID', 'IMDb']],
]
const OTHER = 'Details'
const SECTION_OF = new Map(SECTIONS.flatMap(([name, labels]) => labels.map((l) => [l, name] as const)))
const ORDER = [...SECTIONS.map(([name]) => name), OTHER]
const sectionOf = (f: KnowledgeCard['facts'][number]): string => (f.section && ORDER.includes(f.section) ? f.section : (SECTION_OF.get(f.label) ?? OTHER))
/** Handles and addresses must stay exactly as written. */
const KEEP_CASE = new Set(['Website', 'X (Twitter)', 'Instagram', 'Facebook', 'ORCID', 'IMDb', 'Purpose', 'Used for', 'IUPAC name', 'Scientific name', 'Repository', 'License', 'Code', 'DOI', 'Exchange rate', 'Generic name', 'Formula'])
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'])

/** "licensed behavior analyst" -> "Licensed Behavior Analyst". Small joining words stay lower case unless they start a line. */
export function capitalizeWords(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\p{L}[\p{L}\p{M}'’-]*/gu, (w, at: number) => (at > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))))
    .join('\n')
}

function Facts(props: { facts: KnowledgeCard['facts'] }): ReactElement {
  const present = ORDER.filter((name) => props.facts.some((f) => sectionOf(f) === name))
  return (
    <div className="kc-sections">
      {present.map((name) => (
        <section key={name} className="kc-section">
          {present.length > 1 && <h4>{name}</h4>}
          <dl className="kc-facts">
            {props.facts
              .filter((f) => sectionOf(f) === name)
              .map((f) => {
                const value = f.href || f.section || KEEP_CASE.has(f.label) ? f.value : capitalizeWords(f.value)
                return (
                  <div key={f.label} className={value.includes('\n') ? 'kc-fact multi' : 'kc-fact'}>
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
                          {value}
                        </a>
                      ) : (
                        value
                      )}
                    </dd>
                  </div>
                )
              })}
          </dl>
        </section>
      ))}
    </div>
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
  // Sorted by section first, so the summary and "More facts" keep the same order.
  const ordered = [...card.facts].sort((a, b) => ORDER.indexOf(sectionOf(a)) - ORDER.indexOf(sectionOf(b)))
  const shown = ordered.slice(0, VISIBLE_FACTS)
  const rest = ordered.slice(VISIBLE_FACTS)
  return (
    <aside className="kcard" aria-label={`About ${card.title}`}>
      <div className="kc-head">
        <div className="kc-title">
          {card.kind && <div className="kc-kind">{card.kind}</div>}
          <h3>{card.title}</h3>
          {card.description && <div className="kc-desc">{card.description}</div>}
        </div>
        {card.thumbnail && <img className={card.imageFit ? 'kc-thumb fit' : 'kc-thumb'} src={card.thumbnail} alt="" />}
      </div>
      {card.extract && <p className={more ? 'kc-extract open' : 'kc-extract'}>{card.extract}</p>}
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
        {card.note && <span className="faint">{card.note}</span>}
        {card.wikipediaUrl && <SourceLink url={card.wikipediaUrl}>Wikipedia</SourceLink>}
        {card.wikidataUrl && <SourceLink url={card.wikidataUrl}>Wikidata</SourceLink>}
        {card.sources?.map((s) => (
          <SourceLink key={s.label} url={s.url}>
            {s.label}
          </SourceLink>
        ))}
        {card.wikipediaUrl && <span className="faint">Text from Wikipedia, CC BY-SA 4.0</span>}
        {card.cleaned && <span className="faint">Tidied by AI from these sources</span>}
      </div>
    </aside>
  )
}
