import { describe, expect, it } from 'vitest'
import { interleave, observationsFor, rankPairs } from '../../src/domain/study/recommend'
import type { ItemTags } from '../../src/domain/study/taxonomy'
import { contentPackage } from '../content/scenarios'
import { studyItems } from './service'

const pance = contentPackage().blueprints.find((b) => b.id === 'nccpa-pance-2025')!
const tags = (organSystems: string[]): ItemTags => ({ organSystems, panceTasks: [], topicTags: [], careSettings: [], ageGroups: [], eorRotations: [] })
const DX = 'formulating-the-most-likely-diagnosis'

describe('weakness x weight ranking', () => {
  it('with no attempts, treats every pair as 50% weak and so ranks by blueprint weight', () => {
    const pairs = rankPairs(pance, [], studyItems())
    expect(pairs.every((p) => p.noData && p.weakness === 0.5)).toBe(true)
    // Professional Practice stands alone at 6%; every medical pair is a slice of 94%.
    expect(pairs[0]).toMatchObject({ content: 'professional-practice', task: 'professional-practice' })
    expect(pairs[1]).toMatchObject({ content: 'cardiovascular-system', task: DX })
  })

  it('moves a pair the learner keeps missing above heavier pairs', () => {
    const at = (pairs: ReturnType<typeof rankPairs>, content: string) => pairs.findIndex((p) => p.content === content && p.task === DX)
    const before = rankPairs(pance, [], studyItems())
    expect(at(before, 'pulmonary-system')).toBeGreaterThan(at(before, 'cardiovascular-system'))
    const obs = [1, 2, 3].flatMap((n) => observationsFor(`a${n}`, tags(['pulmonary-system']), ['diagnosis']))
    const after = rankPairs(pance, obs, studyItems())
    const pulmDx = after[at(after, 'pulmonary-system')]
    expect(pulmDx).toMatchObject({ attempts: 3, misses: 3, noData: false })
    expect(pulmDx.weakness).toBeCloseTo(0.8, 9)
    expect(at(after, 'pulmonary-system')).toBeLessThan(at(after, 'cardiovascular-system'))
  })

  it('lowers a pair the learner handles well', () => {
    const obs = [1, 2, 3, 4].flatMap((n) => observationsFor(`a${n}`, tags(['cardiovascular-system']), []))
    const cvDx = rankPairs(pance, obs, studyItems()).find((p) => p.content === 'cardiovascular-system' && p.task === DX)!
    expect(cvDx.weakness).toBeCloseTo(1 / 6, 9)
  })

  it('maps treatment misses to both intervention and pharmacotherapy, and never to unobservable tasks', () => {
    const obs = observationsFor('a', tags(['pulmonary-system']), ['treatment'])
    expect(obs.filter((o) => o.missed).map((o) => o.task).sort()).toEqual(['clinical-intervention', 'pharmaceutical-therapeutics'])
    expect(obs.map((o) => o.task)).not.toContain('health-maintenance-education-prevention')
  })

  it('lists the published cases for each pair and leaves unauthored pairs empty', () => {
    const pairs = rankPairs(pance, [], studyItems())
    expect(pairs.find((p) => p.content === 'cardiovascular-system' && p.task === DX)!.itemIds).toEqual(['chest-pressure'])
    expect(pairs.find((p) => p.content === 'renal-system' && p.task === DX)!.itemIds).toEqual([])
  })
})

describe('interleaving', () => {
  it('avoids repeating a system or task back to back when an alternative exists', () => {
    const out = interleave([
      { content: 'a', task: 'x' },
      { content: 'a', task: 'y' },
      { content: 'b', task: 'x' },
      { content: 'b', task: 'y' },
    ])
    expect(out).toEqual([
      { content: 'a', task: 'x' },
      { content: 'b', task: 'y' },
      { content: 'a', task: 'y' },
      { content: 'b', task: 'x' },
    ])
  })

  it('keeps every entry exactly once', () => {
    const pairs = rankPairs(pance, [], studyItems())
    expect(new Set(pairs.map((p) => `${p.content}|${p.task}`)).size).toBe(pairs.length)
    expect(pairs).toHaveLength(14 * 7 + 1)
  })
})
