import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { PublicCoverage } from '../../api/contracts'
import { CategoryList, SecondaryTargets } from './CoverageViews'
import { PlanRecommendations } from './PlanViews'
import { CoverageBanner, LoadError, SourceNote } from './shared'
import { blueprintName, formatPct, plural, useLoad } from './util'

export function PanceMode({ user }: { user: string | null }) {
  const blueprints = useLoad(() => api.blueprints(), [])
  if (blueprints.error) return <LoadError error={blueprints.error} onRetry={blueprints.reload} />
  if (!blueprints.data) return <div className="loading">Loading the PANCE blueprint...</div>
  const pance = blueprints.data.find((b) => b.exam === 'pance' && b.lifecycle === 'current')
  if (!pance)
    return (
      <div className="empty-state">
        <h1>No current PANCE blueprint</h1>
        <p className="lede">PANCE mode is unavailable until a current blueprint version is added.</p>
      </div>
    )
  return (
    <>
      <section className="page-intro">
        <div>
          <p className="eyebrow">PANCE MODE</p>
          <h1>Study by PANCE weights.</h1>
          <p className="lede">{blueprintName(pance)}</p>
        </div>
      </section>
      <PanceDetail blueprintId={pance.id} user={user} />
    </>
  )
}

function PanceDetail({ blueprintId, user }: { blueprintId: string; user: string | null }) {
  const coverage = useLoad(() => api.coverage(blueprintId), [blueprintId])
  if (coverage.error) return <LoadError error={coverage.error} onRetry={coverage.reload} />
  if (!coverage.data) return <div className="loading">Loading coverage...</div>
  const data = coverage.data
  return (
    <>
      <CoverageBanner data={data} />
      <PairPicker data={data} />
      <PlanRecommendations mode="pance" blueprintId={blueprintId} user={user} titles={data.items} />
      <div className="study-columns study-columns--two">
        <section className="study-section">
          <h2>Content categories</h2>
          <CategoryList data={data} axis="content" />
        </section>
        <section className="study-section">
          <h2>Task categories</h2>
          <CategoryList data={data} axis="task" />
        </section>
      </div>
      <SecondaryTargets data={data} />
      <SourceNote bp={data.blueprint} />
    </>
  )
}

/** Any system x task pair, including ones with no cases. Weights for PANCE pairs are derived, and labelled so. */
function PairPicker({ data }: { data: PublicCoverage }) {
  const { contentCategories, taskCategories, cells } = data.coverage
  const [system, setSystem] = useState(contentCategories[0]?.id ?? '')
  const [task, setTask] = useState(taskCategories[0]?.id ?? '')
  const cell = cells.find((c) => c.content === system && c.task === task)
  return (
    <section className="study-section study-picker" aria-labelledby="pair-picker">
      <h2 id="pair-picker">Find cases by system and task</h2>
      <div className="study-picker-row">
        <label className="study-select">
          System
          <select value={system} onChange={(e) => setSystem(e.target.value)}>
            {contentCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="study-select">
          Task
          <select value={task} onChange={(e) => setTask(e.target.value)}>
            {taskCategories.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <Link className="button button-primary" to={`/cases?system=${encodeURIComponent(system)}&task=${encodeURIComponent(task)}`}>
          Show cases
        </Link>
      </div>
      <p className="study-muted" aria-live="polite">
        {cell && cell.weightPct > 0 ? (
          <>
            {plural(cell.itemIds.length, 'case')} for this pair. Estimated {formatPct(Math.round(cell.weightPct * 10) / 10)} of the exam, derived from the separate content and task
            percentages (NCCPA does not publish a combined table).
          </>
        ) : (
          <>PANCE does not code this pairing: Professional Practice questions are not combined with the medical task categories.</>
        )}
      </p>
    </section>
  )
}
