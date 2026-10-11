import { Link } from 'react-router-dom'
import type { PublicCoverage } from '../../api/contracts'
import { formatPct, plural } from './util'

const titleMap = (data: PublicCoverage) => new Map(data.items.map((i) => [i.id, i.title]))

function CaseLinks({ ids, titles }: { ids: string[]; titles: Map<string, string> }) {
  if (!ids.length) return <span className="study-missing">Not yet authored</span>
  return (
    <span className="study-case-links">
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <Link to={`/encounter/${id}`}>{titles.get(id) ?? id}</Link>
        </span>
      ))}
    </span>
  )
}

/** Content categories with their official weight and which cases (if any) touch them. Works at any width. */
export function CategoryList({ data, axis }: { data: PublicCoverage; axis: 'content' | 'task' }) {
  const titles = titleMap(data)
  const rows = axis === 'content' ? data.coverage.contentCategories : data.coverage.taskCategories
  return (
    <ul className="study-categories">
      {rows.map((c) => (
        <li key={c.id} className={c.status === 'missing' ? 'is-missing' : undefined}>
          <div className="study-category-head">
            <span className="study-category-label">{c.label}</span>
            <span className="study-weight">{formatPct(c.weightPct)} of exam</span>
          </div>
          <div className="study-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, c.weightPct * 4)}%` }} />
          </div>
          <CaseLinks ids={c.itemIds} titles={titles} />
        </li>
      ))}
    </ul>
  )
}

/**
 * The official content x task matrix (PAEA). Each cell shows the official item count and how many practice
 * cases touch it. The two are deliberately not shown as a fraction: a case is not an exam item.
 */
export function CoverageMatrix({ data }: { data: PublicCoverage }) {
  const { coverage } = data
  if (coverage.weightBasis !== 'official-cells') return null
  const cell = (content: string, task: string) => coverage.cells.find((c) => c.content === content && c.task === task)
  return (
    <div className="study-matrix-wrap" role="region" aria-label="Content by task matrix" tabIndex={0}>
      <table className="study-matrix">
        <caption>
          Official items per cell, and practice cases tagged for each. A dash means no case yet; a dot means the blueprint assigns no items.
        </caption>
        <thead>
          <tr>
            <th scope="col">Content area</th>
            {coverage.taskCategories.map((t) => (
              <th scope="col" key={t.id}>
                {t.label}
                <small>{formatPct(t.weightPct)}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {coverage.contentCategories.map((c) => (
            <tr key={c.id}>
              <th scope="row">
                {c.label}
                <small>{formatPct(c.weightPct)}</small>
              </th>
              {coverage.taskCategories.map((t) => {
                const x = cell(c.id, t.id)
                const official = x?.officialItems ?? 0
                const have = x?.itemIds.length ?? 0
                if (official === 0)
                  return (
                    <td key={t.id} className="is-empty">
                      <span aria-hidden="true">·</span>
                      <span className="sr-only">No items on the exam</span>
                    </td>
                  )
                return (
                  <td key={t.id} className={have ? 'has-content' : 'is-missing'}>
                    <span className="study-cell-target">{plural(official, 'item')}</span>
                    {have ? (
                      <span className="study-cell-have">{plural(have, 'case')}</span>
                    ) : (
                      <span className="study-cell-have">
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">no practice case yet</span>
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SecondaryTargets({ data }: { data: PublicCoverage }) {
  if (!data.secondaryTargets.length) return null
  const titles = titleMap(data)
  return (
    <section className="study-section">
      <h2>Other blueprint targets</h2>
      {data.secondaryTargets.map((t) => (
        <ul className="study-categories" key={t.id} aria-label={t.label}>
          {t.values.map((v) => (
            <li key={v.id} className={v.itemIds.length ? undefined : 'is-missing'}>
              <div className="study-category-head">
                <span className="study-category-label">{v.label}</span>
                <span className="study-weight">{v.minPct === v.maxPct ? formatPct(v.minPct) : `${v.minPct}% to ${v.maxPct}%`} of exam</span>
              </div>
              <CaseLinks ids={v.itemIds} titles={titles} />
            </li>
          ))}
        </ul>
      ))}
    </section>
  )
}
