import { AlertTriangle, ClipboardList, FlaskConical, Info, MessageSquareQuote, NotebookPen, Stethoscope } from 'lucide-react'
import { useState } from 'react'
import type { AnnotationMark, PublicAnnotation } from '../../api/contracts'
import { ENTRY_LABEL, MARK_LABEL, marksFor, type CaseEntryData, type EntryKind } from './encounterModel'

const ICON: Record<EntryKind, typeof Info> = { patient: MessageSquareQuote, finding: Stethoscope, result: FlaskConical, note: NotebookPen, system: Info }

export function Portrait({ config, small = false }: { config: { src?: string; alt: string; fallback: string }; small?: boolean }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={`portrait ${small ? 'portrait-small' : ''}`}>
      {config.src && !failed ? (
        <img src={config.src} alt={config.alt} onError={() => setFailed(true)} />
      ) : (
        <span role="img" aria-label={config.alt}>
          {config.fallback}
        </span>
      )}
    </div>
  )
}

export function MarkBadges({ marks }: { marks: AnnotationMark[] }) {
  if (!marks.length) return null
  return (
    <span className="mark-badges">
      {marks.map((m) => (
        <span key={m} className={`mark-badge mark-badge--${m}`}>
          {m === 'ruled_out' ? <span aria-hidden="true">✕ </span> : m === 'key' ? <span aria-hidden="true">★ </span> : <span aria-hidden="true">⚑ </span>}
          {MARK_LABEL[m]}
        </span>
      ))}
    </span>
  )
}

/** One entry. Kind is conveyed by a text label and icon and by shape, never by color alone. */
export function CaseEntry({ entry, marks = [] }: { entry: CaseEntryData; marks?: AnnotationMark[] }) {
  const Icon = entry.tone === 'warning' || entry.tone === 'error' ? AlertTriangle : ICON[entry.kind]
  return (
    <li className={`entry entry--${entry.kind}${entry.tone ? ` entry--${entry.tone}` : ''}`} id={entry.id}>
      <p className="entry-label">
        <Icon size={15} aria-hidden="true" />
        <strong>{entry.label ?? ENTRY_LABEL[entry.kind]}</strong>{' '}
        {entry.context && <span className="entry-context">{entry.context}</span>}{' '}
        <MarkBadges marks={marks} />
      </p>
      {entry.kind === 'patient' ? <blockquote className="entry-text">{entry.text}</blockquote> : <p className="entry-text">{entry.text}</p>}
      {entry.media?.map((m) => (
        <figure key={m.id} className="entry-media">
          <img src={m.src} alt={m.decorative ? '' : m.alt} loading="lazy" />
          {!m.decorative && m.longDescription && (
            <figcaption>
              <details>
                <summary>Image description</summary>
                <p>{m.longDescription}</p>
              </details>
            </figcaption>
          )}
        </figure>
      ))}
    </li>
  )
}

/**
 * The case so far. Not a scroll box: the page scrolls, so nothing is trapped behind an inner scrollbar and the
 * list stays reachable with a keyboard and screen reader.
 */
export function CaseSurface({ entries, annotations, collapsedTo }: { entries: CaseEntryData[]; annotations: PublicAnnotation[]; collapsedTo?: number }) {
  const [showAll, setShowAll] = useState(false)
  const hidden = collapsedTo && !showAll ? Math.max(0, entries.length - collapsedTo) : 0
  const visible = entries.slice(hidden)
  return (
    <section className="case-surface" aria-labelledby="case-surface-title">
      <h2 id="case-surface-title" className="surface-title">
        <ClipboardList size={16} aria-hidden="true" /> Case so far
      </h2>
      {hidden > 0 && (
        <button type="button" className="button button-quiet button-small surface-more" onClick={() => setShowAll(true)}>
          Show {hidden} earlier {hidden === 1 ? 'entry' : 'entries'}
        </button>
      )}
      <ol className="entries">
        {visible.map((e) => (
          <CaseEntry key={e.id} entry={e} marks={e.actionId ? marksFor(annotations, 'action', e.actionId) : []} />
        ))}
      </ol>
    </section>
  )
}
