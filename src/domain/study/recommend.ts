import type { PhaseId } from '../types'
import { blueprintPairs, itemsInScope, matchesCrosswalk, pairWeightPct, type StudyItem } from './coverage'
import type { Blueprint } from './schema'
import type { ItemTags } from './taxonomy'

/**
 * Which task each encounter phase gives evidence about. Only these tasks can ever show a weakness;
 * the others (health maintenance, foundational science, professional practice) stay "no data".
 */
export const PHASE_TASKS: Record<PhaseId, string[]> = {
  history: ['history-taking-physical-examination'],
  exam: ['history-taking-physical-examination'],
  diagnostics: ['using-diagnostic-laboratory-studies'],
  diagnosis: ['formulating-the-most-likely-diagnosis'],
  treatment: ['clinical-intervention', 'pharmaceutical-therapeutics'],
}

/** One submitted attempt's outcome for one task, tagged with the tags of the case version that was played. */
export interface Observation {
  attemptId: string
  tags: ItemTags
  task: string
  missed: boolean
}

/** Turns an attempt's misses into per-task observations: a task is "missed" if any miss fell in a phase that evidences it. */
export function observationsFor(attemptId: string, tags: ItemTags, missPhases: readonly PhaseId[]): Observation[] {
  const missedTasks = new Set(missPhases.flatMap((p) => PHASE_TASKS[p]))
  const tasks = [...new Set(Object.values(PHASE_TASKS).flat())]
  return tasks.map((task) => ({ attemptId, tags, task, missed: missedTasks.has(task) }))
}

export interface PairPlan {
  content: string
  contentLabel: string
  task: string
  taskLabel: string
  weightPct: number
  attempts: number
  misses: number
  /** Posterior mean miss rate under a uniform Beta(1,1) prior; 0.5 when there is no data. */
  weakness: number
  noData: boolean
  score: number
  /** Published items in scope that touch this pair; empty means nothing is authored for it yet. */
  itemIds: string[]
}

/**
 * Ranks blueprint pairs by weakness x weight, then interleaves so consecutive entries never share a content
 * category or a task when an alternative exists. Heuristic, not a validated model; the UI says so.
 */
export function rankPairs(bp: Blueprint, observations: readonly Observation[], items: readonly StudyItem[]): PairPlan[] {
  const scoped = itemsInScope(bp, items)
  const content = new Map(bp.contentCategories.map((c) => [c.id, c]))
  const task = new Map(bp.taskCategories.map((t) => [t.id, t]))
  const plans = blueprintPairs(bp)
    .map(({ content: c, task: t }) => {
      const cat = content.get(c)!
      const tk = task.get(t)!
      const relevant = observations.filter((o) => o.task === tk.canonicalTask && matchesCrosswalk(o.tags, cat.crosswalk))
      const attempts = new Set(relevant.map((o) => o.attemptId)).size
      const misses = new Set(relevant.filter((o) => o.missed).map((o) => o.attemptId)).size
      const weakness = (misses + 1) / (attempts + 2)
      const weightPct = pairWeightPct(bp, c, t)
      return {
        content: c,
        contentLabel: cat.label,
        task: t,
        taskLabel: tk.label,
        weightPct,
        attempts,
        misses,
        weakness,
        noData: attempts === 0,
        score: weakness * weightPct,
        itemIds: scoped.filter((i) => matchesCrosswalk(i.tags, cat.crosswalk) && i.tags.panceTasks.includes(tk.canonicalTask)).map((i) => i.id),
      }
    })
    .filter((p) => p.weightPct > 0)
    .sort((a, b) => b.score - a.score || b.weightPct - a.weightPct || a.content.localeCompare(b.content) || a.task.localeCompare(b.task))
  return interleave(plans)
}

export function interleave<T extends { content: string; task: string }>(sorted: readonly T[]): T[] {
  const pool = [...sorted]
  const out: T[] = []
  while (pool.length) {
    const prev = out.at(-1)
    const idx = prev ? pool.findIndex((p) => p.content !== prev.content && p.task !== prev.task) : 0
    out.push(pool.splice(idx === -1 ? 0 : idx, 1)[0])
  }
  return out
}
