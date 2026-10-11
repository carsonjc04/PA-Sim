import { ChevronLeft } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../../api/client'
import type { PublicBlueprintSummary } from '../../api/contracts'
import { CategoryList, CoverageMatrix, SecondaryTargets } from './CoverageViews'
import { PlanRecommendations } from './PlanViews'
import { CoverageBanner, LoadError, SourceNote } from './shared'
import { blueprintName, lifecycleLabel, useLoad } from './util'

const selectable = (list: PublicBlueprintSummary[], rotation: string) =>
  list.filter((b) => b.rotation === rotation && (b.lifecycle === 'current' || b.lifecycle === 'legacy')).sort((a, b) => (a.lifecycle === b.lifecycle ? 0 : a.lifecycle === 'current' ? -1 : 1))

export function RotationMode({ user }: { user: string | null }) {
  const { rotationId } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const taxonomy = useLoad(() => api.studyTaxonomy(), [])
  const blueprints = useLoad(() => api.blueprints(), [])

  if (taxonomy.error) return <LoadError error={taxonomy.error} onRetry={taxonomy.reload} />
  if (blueprints.error) return <LoadError error={blueprints.error} onRetry={blueprints.reload} />
  if (!taxonomy.data || !blueprints.data) return <div className="loading">Loading rotations...</div>

  const rotations = taxonomy.data.eorRotations
  const rotation = rotations.find((r) => r.id === rotationId)
  if (!rotation) {
    return (
      <>
        <section className="page-intro">
          <div>
            <p className="eyebrow">ROTATION MODE</p>
            <h1>Choose a rotation.</h1>
            <p className="lede">Each rotation uses PAEA&rsquo;s End of Rotation blueprint. Pick one to see its coverage map, due review and suggested cases.</p>
          </div>
        </section>
        <ul className="study-rotation-list">
          {rotations.map((r) => {
            const current = selectable(blueprints.data!, r.id)[0]
            return (
              <li key={r.id}>
                <Link to={`/study/rotation/${r.id}`}>
                  <strong>{r.label}</strong>
                  <span>{current ? `${current.versionLabel} blueprint` : 'No current blueprint'}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </>
    )
  }

  const versions = selectable(blueprints.data, rotation.id)
  const chosen = versions.find((b) => b.id === params.get('version')) ?? versions[0]
  return (
    <>
      <Link className="study-back" to="/study/rotation">
        <ChevronLeft size={15} aria-hidden="true" /> All rotations
      </Link>
      <section className="page-intro">
        <div>
          <p className="eyebrow">ROTATION MODE</p>
          <h1>{rotation.label}</h1>
          {chosen && <p className="lede">{blueprintName(chosen)}</p>}
        </div>
        {versions.length > 1 && (
          <label className="study-select">
            Blueprint version
            <select
              value={chosen?.id}
              onChange={(e) => {
                const next = new URLSearchParams(params)
                next.set('version', e.target.value)
                setParams(next, { replace: true })
              }}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.versionLabel} &mdash; {lifecycleLabel(v)}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
      {!chosen ? (
        <div className="empty-state">
          <h2>No blueprint is available for this rotation today.</h2>
          <button type="button" className="button button-quiet" onClick={() => navigate('/study/rotation')}>
            Choose another rotation
          </button>
        </div>
      ) : (
        <BlueprintDetail blueprintId={chosen.id} user={user} />
      )}
    </>
  )
}

function BlueprintDetail({ blueprintId, user }: { blueprintId: string; user: string | null }) {
  const coverage = useLoad(() => api.coverage(blueprintId), [blueprintId])
  if (coverage.error) return <LoadError error={coverage.error} onRetry={coverage.reload} />
  if (!coverage.data) return <div className="loading">Loading coverage...</div>
  const data = coverage.data
  return (
    <>
      <CoverageBanner data={data} />
      <PlanRecommendations mode="rotation" blueprintId={blueprintId} user={user} titles={data.items} />
      <section className="study-section">
        <h2>Coverage map</h2>
        <CoverageMatrix data={data} />
      </section>
      <section className="study-section">
        <h2>Content areas</h2>
        <CategoryList data={data} axis="content" />
      </section>
      <SecondaryTargets data={data} />
      <SourceNote bp={data.blueprint} />
    </>
  )
}
