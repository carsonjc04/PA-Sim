import type { PublicTaxonomy } from '../../api/contracts'
import type { CaseFilterKey, CaseFilterValues } from './filterState'

/**
 * Every active PANCE system, task and core rotation is selectable, including combinations with no cases,
 * so a learner sees an empty result rather than a hidden one.
 */
export function CaseFilters({
  taxonomy,
  failed,
  filters,
  onChange,
  onClear,
  active,
}: {
  taxonomy: PublicTaxonomy | null
  failed: boolean
  filters: CaseFilterValues
  onChange: (key: CaseFilterKey, value: string) => void
  onClear: () => void
  active: boolean
}) {
  if (failed) return <p className="study-muted">Filters are unavailable right now.</p>
  if (!taxonomy) return null
  const field = (key: CaseFilterKey, label: string, all: string, terms: { id: string; label: string }[]) => (
    <label className="study-select">
      {label}
      <select value={filters[key]} onChange={(e) => onChange(key, e.target.value)}>
        <option value="">{all}</option>
        {terms.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <form className="study-filters" aria-label="Filter cases" onSubmit={(e) => e.preventDefault()}>
      {field('system', 'PANCE system', 'All systems', taxonomy.organSystems)}
      {field('task', 'PANCE task', 'All tasks', taxonomy.panceTasks)}
      {field('rotation', 'EOR rotation', 'All rotations', taxonomy.eorRotations)}
      {active && (
        <button type="button" className="button button-quiet" onClick={onClear}>
          Clear filters
        </button>
      )}
    </form>
  )
}
