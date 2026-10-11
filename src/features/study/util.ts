import { useCallback, useEffect, useState, type DependencyList } from 'react'
import { ApiRequestError } from '../../api/client'
import type { PublicBlueprintSummary } from '../../api/contracts'

export function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message
  return 'Something went wrong. Try again.'
}

/** Loads once per dependency change; `reload` retries after an error. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    load()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(messageOf(e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, reload }
}

export const formatPct = (n: number) => (Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`)
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const blueprintName = (bp: Pick<PublicBlueprintSummary, 'title' | 'versionLabel'>) => `${bp.title} (${bp.versionLabel})`

export const lifecycleLabel = (bp: PublicBlueprintSummary) =>
  bp.lifecycle === 'legacy' ? `Legacy${bp.effectiveUntil ? `, valid through ${bp.effectiveUntil}` : ''}` : bp.lifecycle === 'current' ? 'Current' : bp.lifecycle
