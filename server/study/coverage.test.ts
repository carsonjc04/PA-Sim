import { describe, expect, it } from 'vitest'
import { alignmentClaim, blueprintPairs, computeCoverage, fullExamGate, pairWeightPct, type StudyItem } from '../../src/domain/study/coverage'
import type { Blueprint } from '../../src/domain/study/schema'
import { contentPackage } from '../content/scenarios'
import { studyItems } from './service'

const pkg = contentPackage()
const items = studyItems()
const byId = (id: string) => pkg.blueprints.find((b) => b.id === id)!
const pance = byId('nccpa-pance-2025')
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)

const item = (id: string, over: Partial<StudyItem['tags']> = {}, extra: Partial<StudyItem> = {}): StudyItem => ({
  id,
  title: id,
  kind: 'case',
  status: 'draft',
  blueprintReviews: [],
  tags: { organSystems: [], panceTasks: [], topicTags: [], careSettings: [], ageGroups: [], eorRotations: [], ...over },
  ...extra,
})

describe('empty categories', () => {
  it('marks PANCE content categories with no authored case as missing, with a zero count', () => {
    const cov = computeCoverage(pance, items)
    const missing = cov.contentCategories.filter((c) => c.status === 'missing').map((c) => c.id)
    expect(missing).toEqual(expect.arrayContaining(['musculoskeletal-system', 'neurologic-system', 'dermatologic-system', 'hematologic-system', 'renal-system', 'professional-practice']))
    for (const c of cov.contentCategories.filter((x) => x.status === 'missing')) expect(c.itemIds).toEqual([])
    expect(cov.summary.contentCategoriesWithItems).toBeLessThan(cov.summary.contentCategories)
  })

  it('never reports a category, task or cell as complete', () => {
    for (const bp of pkg.blueprints) {
      const cov = computeCoverage(bp, items)
      const statuses = new Set([...cov.contentCategories, ...cov.taskCategories, ...cov.cells].map((x) => x.status))
      for (const s of statuses) expect(['missing', 'has-content']).toContain(s)
    }
  })

  it('reports a rotation with no tagged cases as entirely missing', () => {
    for (const id of ['paea-eor-surgery-2023', 'paea-eor-pediatrics-2026', 'paea-eor-psychiatry-behavioral-health-2026']) {
      const cov = computeCoverage(byId(id), items)
      expect(cov.summary.itemsInScope, id).toBe(0)
      expect(cov.contentCategories.every((c) => c.status === 'missing'), id).toBe(true)
    }
  })

  it('counts only rotation-tagged cases for a rotation blueprint', () => {
    const cov = computeCoverage(byId('paea-eor-emergency-medicine-2026'), items)
    expect(cov.scope).toBe('rotation-tagged')
    const ids = new Set(cov.contentCategories.flatMap((c) => c.itemIds))
    expect([...ids].sort()).toEqual(['asthma', 'chest-pressure'])
  })
})

describe('pair weights', () => {
  it('uses official cell counts for PAEA and totals 100%', () => {
    const fm = byId('paea-eor-family-medicine-2026')
    expect(pairWeightPct(fm, 'cardiovascular', 'dx')).toBe(3)
    expect(sum(blueprintPairs(fm).map((p) => pairWeightPct(fm, p.content, p.task)))).toBeCloseTo(100, 9)
  })

  it('derives PANCE pair weights from the marginals, totalling 100%, with Professional Practice only on its own', () => {
    const pairs = blueprintPairs(pance)
    expect(pairs).toHaveLength(14 * 7 + 1)
    expect(sum(pairs.map((p) => pairWeightPct(pance, p.content, p.task)))).toBeCloseTo(100, 9)
    expect(pairWeightPct(pance, 'professional-practice', 'professional-practice')).toBe(6)
    expect(pairWeightPct(pance, 'cardiovascular-system', 'professional-practice')).toBe(0)
    expect(pairWeightPct(pance, 'cardiovascular-system', 'formulating-the-most-likely-diagnosis')).toBeCloseTo((11 * 18) / 94, 9)
  })
})

describe('full-length exam gate', () => {
  it('is closed for every shipped blueprint', () => {
    for (const bp of pkg.blueprints) expect(fullExamGate(bp, items).available, bp.id).toBe(false)
  })

  it('never opens for PANCE, which publishes no exam length or matrix', () => {
    const gate = fullExamGate(pance, items)
    expect(gate.requiredItems).toBeNull()
    expect(gate.reason).toMatch(/no exam length/)
  })

  const tiny: Blueprint = {
    ...byId('paea-eor-family-medicine-2026'),
    id: 'tiny',
    examStructure: { items: 2, format: 'test' },
    contentCategories: [{ id: 'cv', label: 'CV', weightPct: 100, crosswalk: { anyOf: [{ organSystems: ['cardiovascular-system'] }] } }],
    taskCategories: [
      { id: 'dx', label: 'Dx', weightPct: 50, canonicalTask: 'formulating-the-most-likely-diagnosis' },
      { id: 'ct', label: 'Ct', weightPct: 50, canonicalTask: 'pharmaceutical-therapeutics' },
    ],
    cells: [{ content: 'cv', task: 'dx', items: 1 }, { content: 'cv', task: 'ct', items: 1 }],
    rotation: 'family-medicine',
  }
  const cv = (id: string, tasks: string[], status = 'approved') => item(id, { organSystems: ['cardiovascular-system'], panceTasks: tasks, eorRotations: ['family-medicine'] }, { status })

  it('opens only when every cell can be filled with distinct approved items', () => {
    expect(fullExamGate(tiny, [cv('a', ['formulating-the-most-likely-diagnosis']), cv('b', ['pharmaceutical-therapeutics'])]).available).toBe(true)
  })

  it('stays closed when one item would have to fill two slots (no repetition)', () => {
    const gate = fullExamGate(tiny, [cv('a', ['formulating-the-most-likely-diagnosis', 'pharmaceutical-therapeutics'])])
    expect(gate.available).toBe(false)
  })

  it('stays closed for draft items', () => {
    expect(fullExamGate(tiny, [cv('a', ['formulating-the-most-likely-diagnosis'], 'draft'), cv('b', ['pharmaceutical-therapeutics'], 'draft')]).available).toBe(false)
  })
})

describe('alignment claim', () => {
  it('is false for every shipped blueprint: no case has been reviewed against one', () => {
    for (const bp of pkg.blueprints) expect(alignmentClaim(bp, items).claimed, bp.id).toBe(false)
  })

  it('needs every in-scope item reviewed against that exact blueprint version', () => {
    const reviewed = (id: string, bpId: string) => item(id, {}, { blueprintReviews: [{ blueprintId: bpId }] })
    expect(alignmentClaim(pance, [reviewed('a', 'nccpa-pance-2025'), reviewed('b', 'nccpa-pance-2025')]).claimed).toBe(true)
    expect(alignmentClaim(pance, [reviewed('a', 'nccpa-pance-2025'), reviewed('b', 'nccpa-pance-2019')]).claimed).toBe(false)
    expect(alignmentClaim(pance, []).claimed).toBe(false)
  })
})
