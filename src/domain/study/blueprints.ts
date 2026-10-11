import type { Blueprint } from './schema'

export type BlueprintLifecycle = 'current' | 'legacy' | 'upcoming' | 'retired'

/**
 * Lifecycle on a given day, derived from the recorded dates so a version retires on schedule without a data edit.
 * - retired: past effectiveUntil (kept for history; never offered for new study)
 * - upcoming: before effectiveFrom
 * - legacy: still administrable, but a successor is current
 * - current: otherwise
 */
export function blueprintLifecycle(bp: Blueprint, all: readonly Blueprint[], today: string): BlueprintLifecycle {
  if (bp.effectiveUntil && today > bp.effectiveUntil) return 'retired'
  if (bp.effectiveFrom && today < bp.effectiveFrom) return 'upcoming'
  const successor = bp.supersededBy ? all.find((b) => b.id === bp.supersededBy) : undefined
  if (successor) {
    const startedOrUndated = !successor.effectiveFrom || today >= successor.effectiveFrom
    const stillValid = !successor.effectiveUntil || today <= successor.effectiveUntil
    if (startedOrUndated && stillValid) return 'legacy'
  }
  return 'current'
}

/** Versions a learner may pick today: current first, then legacy. Retired and upcoming versions are excluded. */
export function selectableBlueprints(all: readonly Blueprint[], today: string, scope: { exam: 'pance' } | { rotation: string }): Blueprint[] {
  const inScope = all.filter((b) => ('exam' in scope ? b.exam === 'pance' : b.rotation === scope.rotation))
  const rank = { current: 0, legacy: 1, upcoming: 2, retired: 3 } as const
  return inScope
    .map((b) => ({ b, life: blueprintLifecycle(b, all, today) }))
    .filter((x) => x.life === 'current' || x.life === 'legacy')
    .sort((x, y) => rank[x.life] - rank[y.life] || x.b.id.localeCompare(y.b.id))
    .map((x) => x.b)
}

export function defaultBlueprint(all: readonly Blueprint[], today: string, scope: { exam: 'pance' } | { rotation: string }): Blueprint | null {
  return selectableBlueprints(all, today, scope)[0] ?? null
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10)
