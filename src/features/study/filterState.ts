import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../api/client'
import type { PublicScenario, PublicTaxonomy } from '../../api/contracts'

export type CaseFilterKey = 'system' | 'task' | 'rotation'
export type CaseFilterValues = Record<CaseFilterKey, string>

/** Case-library filters held in the URL (?system=&task=&rotation=) so study modes can link straight to a pair. */
export function useCaseFilters() {
  const [params, setParams] = useSearchParams()
  const [taxonomy, setTaxonomy] = useState<PublicTaxonomy | null>(null)
  const [taxonomyFailed, setTaxonomyFailed] = useState(false)
  useEffect(() => {
    api
      .studyTaxonomy()
      .then(setTaxonomy)
      .catch(() => setTaxonomyFailed(true))
  }, [])
  const filters: CaseFilterValues = { system: params.get('system') ?? '', task: params.get('task') ?? '', rotation: params.get('rotation') ?? '' }
  const set = (key: CaseFilterKey, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }
  const clear = () => setParams(new URLSearchParams(), { replace: true })
  const matches = (s: PublicScenario) =>
    (!filters.system || s.tags.organSystems.includes(filters.system)) &&
    (!filters.task || s.tags.panceTasks.includes(filters.task)) &&
    (!filters.rotation || s.tags.eorRotations.includes(filters.rotation))
  const label = (key: CaseFilterKey, id: string) => {
    const list = key === 'system' ? taxonomy?.organSystems : key === 'task' ? taxonomy?.panceTasks : taxonomy?.eorRotations
    return list?.find((t) => t.id === id)?.label ?? id
  }
  const active = Boolean(filters.system || filters.task || filters.rotation)
  const emptyMessage = `No cases are authored for ${(['system', 'task', 'rotation'] as const).filter((k) => filters[k]).map((k) => label(k, filters[k])).join(' × ')} yet.`
  return { filters, set, clear, matches, active, taxonomy, taxonomyFailed, emptyMessage }
}
