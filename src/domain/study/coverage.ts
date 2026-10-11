import type { Blueprint, Crosswalk, CrosswalkClause } from './schema'
import type { ItemTags } from './taxonomy'

/** A practice item as coverage sees it: canonical tags plus what is needed for the gates. */
export interface StudyItem {
  id: string
  title: string
  kind: 'case' | 'sprint'
  tags: ItemTags
  /** Lifecycle status of the item; only `approved` items count toward a full-length exam. */
  status: string
  blueprintReviews: { blueprintId: string }[]
}

const anyOf = (have: readonly string[], want?: readonly string[]) => !want || want.some((w) => have.includes(w))

export function matchesClause(tags: ItemTags, c: CrosswalkClause): boolean {
  return (
    anyOf(tags.organSystems, c.organSystems) &&
    anyOf(tags.panceTasks, c.panceTasks) &&
    anyOf(tags.topicTags, c.topicTags) &&
    anyOf(tags.careSettings, c.careSettings) &&
    anyOf(tags.ageGroups, c.ageGroups)
  )
}

export const matchesCrosswalk = (tags: ItemTags, cw: Crosswalk) => cw.anyOf.some((c) => matchesClause(tags, c))

/**
 * "missing": no authored item touches this category. "has-content": at least one does.
 * There is deliberately no "complete" status: an item touching a category says nothing about whether the
 * category's breadth is covered, and no shipped item has been reviewed against a blueprint.
 */
export type CoverageStatus = 'missing' | 'has-content'

export interface CategoryCoverage {
  id: string
  label: string
  weightPct: number
  itemIds: string[]
  status: CoverageStatus
}

export interface CellCoverage {
  content: string
  task: string
  /** Official item count (PAEA). Null when the issuer publishes no matrix (PANCE). */
  officialItems: number | null
  /** Share of the exam this pair represents. Derived for PANCE; see weightBasis. */
  weightPct: number
  itemIds: string[]
  status: CoverageStatus
}

export interface BlueprintCoverage {
  blueprintId: string
  /** Rotation blueprints count only items their author tagged for that rotation. */
  scope: 'all-items' | 'rotation-tagged'
  weightBasis: 'official-cells' | 'product-of-marginals'
  contentCategories: CategoryCoverage[]
  taskCategories: CategoryCoverage[]
  cells: CellCoverage[]
  summary: {
    itemsInScope: number
    contentCategoriesWithItems: number
    contentCategories: number
    taskCategoriesWithItems: number
    taskCategories: number
    /** Cells the blueprint actually weights (official count or derived weight above zero). */
    cellsWithItems: number
    weightedCells: number
  }
}

export function itemsInScope(bp: Blueprint, items: readonly StudyItem[]): StudyItem[] {
  return bp.rotation ? items.filter((i) => i.tags.eorRotations.includes(bp.rotation as string)) : [...items]
}

/** Pairs PANCE allows: medical content x medical tasks, plus each exclusion pair on its own. */
function pancePairs(bp: Blueprint): { content: string; task: string }[] {
  const ex = bp.taskCodingExclusions ?? []
  const exContent = new Set(ex.map((e) => e.content))
  const exTask = new Set(ex.map((e) => e.task))
  const pairs: { content: string; task: string }[] = []
  for (const c of bp.contentCategories) {
    if (exContent.has(c.id)) continue
    for (const t of bp.taskCategories) if (!exTask.has(t.id)) pairs.push({ content: c.id, task: t.id })
  }
  return [...pairs, ...ex]
}

/**
 * Weight of one content x task pair as a percent of the exam.
 * PAEA publishes item counts per cell, so the weight is official. NCCPA publishes only the two marginal
 * distributions, so for PANCE the weight is an assumption: content% x task% / medical share, which treats the
 * axes as independent. The UI labels this as derived.
 */
export function pairWeightPct(bp: Blueprint, content: string, task: string): number {
  if (bp.cells) {
    const cell = bp.cells.find((c) => c.content === content && c.task === task)
    const total = bp.examStructure.items ?? bp.cells.reduce((n, c) => n + c.items, 0)
    return cell ? (cell.items / total) * 100 : 0
  }
  const ex = bp.taskCodingExclusions ?? []
  const pair = ex.find((e) => e.content === content && e.task === task)
  const c = bp.contentCategories.find((x) => x.id === content)
  const t = bp.taskCategories.find((x) => x.id === task)
  if (!c || !t) return 0
  if (pair) return c.weightPct
  if (ex.some((e) => e.content === content || e.task === task)) return 0
  const medical = 100 - ex.reduce((n, e) => n + (bp.contentCategories.find((x) => x.id === e.content)?.weightPct ?? 0), 0)
  return (c.weightPct * t.weightPct) / medical
}

export function blueprintPairs(bp: Blueprint): { content: string; task: string }[] {
  return bp.cells ? bp.cells.map(({ content, task }) => ({ content, task })) : pancePairs(bp)
}

export function computeCoverage(bp: Blueprint, allItems: readonly StudyItem[]): BlueprintCoverage {
  const items = itemsInScope(bp, allItems)
  const status = (ids: string[]): CoverageStatus => (ids.length ? 'has-content' : 'missing')
  const inContent = new Map(bp.contentCategories.map((c) => [c.id, items.filter((i) => matchesCrosswalk(i.tags, c.crosswalk)).map((i) => i.id)]))
  const taskOf = new Map(bp.taskCategories.map((t) => [t.id, t.canonicalTask]))
  const inTask = new Map(bp.taskCategories.map((t) => [t.id, items.filter((i) => i.tags.panceTasks.includes(t.canonicalTask)).map((i) => i.id)]))

  const contentCategories = bp.contentCategories.map((c) => ({ id: c.id, label: c.label, weightPct: c.weightPct, itemIds: inContent.get(c.id) ?? [], status: status(inContent.get(c.id) ?? []) }))
  const taskCategories = bp.taskCategories.map((t) => ({ id: t.id, label: t.label, weightPct: t.weightPct, itemIds: inTask.get(t.id) ?? [], status: status(inTask.get(t.id) ?? []) }))
  const cells = blueprintPairs(bp).map(({ content, task }) => {
    const canonical = taskOf.get(task) as string
    const ids = (inContent.get(content) ?? []).filter((id) => items.find((i) => i.id === id)?.tags.panceTasks.includes(canonical))
    return {
      content,
      task,
      officialItems: bp.cells?.find((c) => c.content === content && c.task === task)?.items ?? null,
      weightPct: pairWeightPct(bp, content, task),
      itemIds: ids,
      status: status(ids),
    }
  })
  const weighted = cells.filter((c) => c.weightPct > 0)
  return {
    blueprintId: bp.id,
    scope: bp.rotation ? 'rotation-tagged' : 'all-items',
    weightBasis: bp.cells ? 'official-cells' : 'product-of-marginals',
    contentCategories,
    taskCategories,
    cells,
    summary: {
      itemsInScope: items.length,
      contentCategoriesWithItems: contentCategories.filter((c) => c.itemIds.length).length,
      contentCategories: contentCategories.length,
      taskCategoriesWithItems: taskCategories.filter((c) => c.itemIds.length).length,
      taskCategories: taskCategories.length,
      cellsWithItems: weighted.filter((c) => c.itemIds.length).length,
      weightedCells: weighted.length,
    },
  }
}

export interface FullExamGate {
  available: boolean
  /** Why not, in learner-facing words. */
  reason: string
  requiredItems: number | null
  approvedItemsInScope: number
  /** Weighted cells that cannot be filled with distinct approved items. */
  cellsShort: number
}

/**
 * A full-length practice exam is offered only when every official cell can be filled with distinct, approved
 * items (no item used twice). Checked as a bipartite matching of exam slots to items. PANCE never qualifies:
 * NCCPA publishes no exam length or content-by-task matrix in the blueprint, so its structure cannot be met.
 */
export function fullExamGate(bp: Blueprint, allItems: readonly StudyItem[]): FullExamGate {
  const approved = itemsInScope(bp, allItems).filter((i) => i.status === 'approved')
  if (!bp.cells || !bp.examStructure.items) {
    return { available: false, reason: 'This blueprint publishes percentages but no exam length or content-by-task matrix, so PA-Sim cannot reproduce its structure.', requiredItems: null, approvedItemsInScope: approved.length, cellsShort: blueprintPairs(bp).length }
  }
  const coverage = computeCoverage(bp, approved)
  const slots: string[][] = []
  let cellsShort = 0
  for (const cell of coverage.cells) {
    const need = cell.officialItems ?? 0
    if (need > cell.itemIds.length) cellsShort += 1
    for (let k = 0; k < need; k += 1) slots.push(cell.itemIds)
  }
  const matched = cellsShort === 0 ? maxMatching(slots) : 0
  const available = cellsShort === 0 && matched === slots.length
  return {
    available,
    reason: available
      ? 'Every cell of the official blueprint can be filled with distinct approved items.'
      : `A full-length exam needs ${bp.examStructure.items} distinct approved items matching the official blueprint; ${approved.length} approved item${approved.length === 1 ? '' : 's'} exist for it, and ${cellsShort} of ${coverage.cells.filter((c) => (c.officialItems ?? 0) > 0).length} weighted cells cannot be filled.`,
    requiredItems: bp.examStructure.items,
    approvedItemsInScope: approved.length,
    cellsShort,
  }
}

/** Kuhn's augmenting-path matching: how many slots can get a distinct item. */
function maxMatching(slots: string[][]): number {
  const owner = new Map<string, number>()
  const tryAssign = (slot: number, seen: Set<string>): boolean => {
    for (const item of slots[slot]) {
      if (seen.has(item)) continue
      seen.add(item)
      const current = owner.get(item)
      if (current === undefined || tryAssign(current, seen)) {
        owner.set(item, slot)
        return true
      }
    }
    return false
  }
  let n = 0
  for (let s = 0; s < slots.length; s += 1) if (tryAssign(s, new Set())) n += 1
  return n
}

export interface AlignmentClaim {
  claimed: boolean
  reviewedItems: number
  totalItems: number
}

/** "Aligned to <blueprint>" may be shown only when every shipped item in scope was reviewed against that exact version. */
export function alignmentClaim(bp: Blueprint, allItems: readonly StudyItem[]): AlignmentClaim {
  const items = itemsInScope(bp, allItems)
  const reviewed = items.filter((i) => i.blueprintReviews.some((r) => r.blueprintId === bp.id)).length
  return { claimed: items.length > 0 && reviewed === items.length, reviewedItems: reviewed, totalItems: items.length }
}
