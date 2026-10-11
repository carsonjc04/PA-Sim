import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { PublicStudyPlan, StudyMode } from '../../api/contracts'
import { LoadError } from './shared'
import { formatPct, plural, useLoad } from './util'

type Titles = { id: string; title: string }[]

/** Personal suggestions for a blueprint: due review that falls in it, cases to practice next, and the biggest unauthored gaps. */
export function PlanRecommendations({ mode, blueprintId, user, titles }: { mode: StudyMode; blueprintId: string; user: string | null; titles: Titles }) {
  if (!user)
    return (
      <section className="study-section study-personal">
        <h2>Your next steps</h2>
        <p className="study-muted">Choose a development identity in the header to see review that is due and cases suggested from your own attempts.</p>
      </section>
    )
  return <PersonalPlan mode={mode} blueprintId={blueprintId} user={user} titles={titles} />
}

function PersonalPlan({ mode, blueprintId, user, titles }: { mode: StudyMode; blueprintId: string; user: string; titles: Titles }) {
  const plan = useLoad(() => api.studyPlan(mode, blueprintId), [mode, blueprintId, user])
  if (plan.error) return <LoadError error={plan.error} onRetry={plan.reload} />
  if (!plan.data) return <div className="loading">Loading your plan...</div>
  const p = plan.data
  const title = new Map(titles.map((t) => [t.id, t.title]))
  const recommended: { id: string; why: string }[] = []
  for (const pair of p.pairs) {
    for (const id of pair.itemIds) if (!recommended.some((r) => r.id === id)) recommended.push({ id, why: `${pair.contentLabel} × ${pair.taskLabel}` })
    if (recommended.length >= 3) break
  }
  const gaps = p.pairs.filter((x) => !x.itemIds.length).slice(0, 3)
  return (
    <section className="study-section study-personal">
      <h2>Your next steps</h2>
      <div className="study-columns">
        <div>
          <h3>Review due today</h3>
          {p.dueRemediation.length ? (
            <>
              <ul className="study-list">
                {p.dueRemediation.map((d) => (
                  <li key={d.cardId}>{d.label}</li>
                ))}
              </ul>
              <Link className="button button-small" to="/review">
                Open today&rsquo;s review
              </Link>
            </>
          ) : (
            <p className="study-muted">Nothing in this blueprint is due.</p>
          )}
        </div>
        <div>
          <h3>Suggested cases</h3>
          {recommended.length ? (
            <ul className="study-list">
              {recommended.map((r) => (
                <li key={r.id}>
                  <Link to={`/encounter/${r.id}`}>{title.get(r.id) ?? r.id}</Link>
                  <small>{r.why}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="study-muted">No published case is tagged for this blueprint yet.</p>
          )}
        </div>
        <div>
          <h3>Heaviest areas with no case yet</h3>
          {gaps.length ? (
            <ul className="study-list">
              {gaps.map((g) => (
                <li key={`${g.content}|${g.task}`}>
                  {g.contentLabel} × {g.taskLabel}
                  <small>{formatPct(Math.round(g.weightPct * 10) / 10)} of exam</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="study-muted">Every weighted area has at least one case.</p>
          )}
        </div>
      </div>
      <p className="study-muted">
        Based on {plural(p.basis.submittedAttempts, 'submitted attempt')}. {p.basis.method}
      </p>
    </section>
  )
}

export function PairQueue({ plan, titles, limit = 12 }: { plan: PublicStudyPlan; titles: Titles; limit?: number }) {
  const title = new Map(titles.map((t) => [t.id, t.title]))
  return (
    <ol className="study-queue">
      {plan.pairs.slice(0, limit).map((p) => (
        <li key={`${p.content}|${p.task}`}>
          <div className="study-queue-head">
            <strong>
              {p.contentLabel} <span aria-hidden="true">×</span>
              <span className="sr-only">and</span> {p.taskLabel}
            </strong>
            <span className="study-weight">{formatPct(Math.round(p.weightPct * 10) / 10)} of exam</span>
          </div>
          <p className="study-muted">
            {p.noData ? 'No attempts yet: counted as 50% until you practice it.' : `Missed in ${p.misses} of ${plural(p.attempts, 'attempt')} (weakness ${Math.round(p.weakness * 100)}%).`}
          </p>
          {p.itemIds.length ? (
            <span className="study-case-links">
              {p.itemIds.map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  <Link to={`/encounter/${id}`}>{title.get(id) ?? id}</Link>
                </span>
              ))}
            </span>
          ) : (
            <span className="study-missing">Not yet authored</span>
          )}
        </li>
      ))}
    </ol>
  )
}
