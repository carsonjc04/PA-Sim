import { useState } from 'react'
import { api } from '../../api/client'
import { PairQueue } from './PlanViews'
import { LoadError } from './shared'
import { plural, useLoad } from './util'

export function MixedMode({ user }: { user: string }) {
  const blueprints = useLoad(() => api.blueprints(), [])
  const [choice, setChoice] = useState<string | null>(null)
  if (blueprints.error) return <LoadError error={blueprints.error} onRetry={blueprints.reload} />
  if (!blueprints.data) return <div className="loading">Loading blueprints...</div>
  const options = blueprints.data.filter((b) => b.lifecycle === 'current').sort((a, b) => (a.exam === b.exam ? a.title.localeCompare(b.title) : a.exam === 'pance' ? -1 : 1))
  const blueprintId = choice ?? options[0]?.id
  return (
    <>
      <section className="page-intro">
        <div>
          <p className="eyebrow">MIXED MODE</p>
          <h1>Interleave your weakest areas.</h1>
          <p className="lede">Systems and tasks are mixed so consecutive items differ, ordered by your misses weighted by the blueprint.</p>
        </div>
        <label className="study-select">
          Weight by
          <select value={blueprintId} onChange={(e) => setChoice(e.target.value)}>
            {options.map((b) => (
              <option key={b.id} value={b.id}>
                {b.exam === 'pance' ? 'PANCE' : b.title.replace(' End of Rotation Exam Blueprint', ' EOR')} ({b.versionLabel})
              </option>
            ))}
          </select>
        </label>
      </section>
      {blueprintId && <MixedQueue blueprintId={blueprintId} user={user} />}
    </>
  )
}

function MixedQueue({ blueprintId, user }: { blueprintId: string; user: string }) {
  const plan = useLoad(() => api.studyPlan('mixed', blueprintId), [blueprintId, user])
  const coverage = useLoad(() => api.coverage(blueprintId), [blueprintId])
  if (plan.error) return <LoadError error={plan.error} onRetry={plan.reload} />
  if (coverage.error) return <LoadError error={coverage.error} onRetry={coverage.reload} />
  if (!plan.data || !coverage.data) return <div className="loading">Building your queue...</div>
  const authored = plan.data.pairs.filter((p) => p.itemIds.length).length
  return (
    <>
      <section className="study-banner" aria-label="How this queue is built">
        <p className="study-banner-lead">
          {plan.data.basis.submittedAttempts === 0 ? (
            <>
              <strong>No submitted attempts yet.</strong> Until you practice, the queue simply follows the blueprint weights.
            </>
          ) : (
            <>
              Built from <strong>{plural(plan.data.basis.submittedAttempts, 'submitted attempt')}</strong>.
            </>
          )}{' '}
          {authored} of {plural(plan.data.pairs.length, 'weighted pair')} have a practice case; the rest show as not yet authored.
        </p>
        <p className="study-muted">{plan.data.basis.method}</p>
      </section>
      <PairQueue plan={plan.data} titles={coverage.data.items} />
    </>
  )
}
