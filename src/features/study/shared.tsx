import type { PublicBlueprintSummary, PublicCoverage } from '../../api/contracts'
import { blueprintName, plural } from './util'

export function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="voice-error" role="alert">
      <p>{error}</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

/**
 * The honesty line shown above every coverage view. States what share of categories has any case, that this is
 * not a full-length exam and why, and never claims alignment unless every in-scope item was reviewed.
 */
export function CoverageBanner({ data }: { data: PublicCoverage }) {
  const s = data.coverage.summary
  const missing = s.contentCategories - s.contentCategoriesWithItems
  return (
    <section className="study-banner" aria-label="Coverage summary">
      <p className="study-banner-lead">
        <strong>
          {s.contentCategoriesWithItems} of {s.contentCategories}
        </strong>{' '}
        content categories have at least one practice case
        {missing > 0 ? `; ${plural(missing, 'category', 'categories')} ${missing === 1 ? 'has' : 'have'} none yet` : ''}.{' '}
        {data.coverage.scope === 'rotation-tagged' && <>Only cases tagged for this rotation are counted. </>}
        Cases touching a category do not cover its breadth.
      </p>
      <ul className="study-banner-facts">
        <li>
          <strong>Not a full-length exam.</strong> {data.fullExam.reason}
        </li>
        <li>
          {data.alignment.claimed ? (
            <>Every case here was reviewed against {blueprintName(data.blueprint)}.</>
          ) : (
            <>
              <strong>Not aligned to this blueprint.</strong> {data.alignment.reviewedItems} of {plural(data.alignment.totalItems, 'case')} in scope{' '}
              {data.alignment.reviewedItems === 1 ? 'has' : 'have'} been reviewed against this version. Tags are author-proposed.
            </>
          )}
        </li>
        {!data.blueprint.transcriptionVerified && (
          <li>The blueprint numbers were transcribed from the official document and have not yet been double-checked by a second person.</li>
        )}
      </ul>
    </section>
  )
}

export function SourceNote({ bp }: { bp: PublicBlueprintSummary }) {
  const dates = [bp.effectiveFrom ? `effective ${bp.effectiveFrom}` : 'start date not stated', bp.effectiveUntil ? `administrable through ${bp.effectiveUntil}` : null].filter(Boolean).join(', ')
  return (
    <aside className="study-source" aria-label="Blueprint source">
      <p>
        <strong>Source:</strong> {bp.issuer},{' '}
        <a href={bp.source.documentUrl} target="_blank" rel="noreferrer">
          {blueprintName(bp)}
        </a>{' '}
        ({dates}). Retrieved {bp.source.retrievedAt}; SHA-256 <code>{bp.source.sha256.slice(0, 12)}</code>.
      </p>
      {bp.source.retrievalNote && <p>{bp.source.retrievalNote}</p>}
      <p>{bp.dateNotes}</p>
      {bp.notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </aside>
  )
}
