import { describe, expect, it } from 'vitest'
import { loadContent } from './package'
import { gradeAttempt } from '../../src/domain/grading'
import type { Attempt, PhaseId, ScenarioDefinition } from '../../src/domain/types'
import { classifyMiss, deriveMisses, possibleMissItems } from '../../src/domain/remediation/misses'
import { GUESSED_CORRECT_ITEM, type Miss } from '../../src/domain/remediation/types'

const pkg = loadContent()
const byId = (id: string) => pkg.scenarios.find((s) => s.id === id)!
const attemptOf = (s: ScenarioDefinition, selectedByPhase: Record<PhaseId, string[]>): Attempt => ({
  id: 't',
  scenarioId: s.id,
  startedAt: '1970-01-01',
  selectedByPhase,
  phaseLocks: [],
  revealed: [],
  submitted: true,
})
const cases = pkg.scenarios.flatMap((s) => pkg.fixtures[s.id].fixtures.map((f) => ({ s, f })))

describe('deriveMisses matches the grader', () => {
  it.each(cases.map(({ s, f }) => [`${s.id}/${f.id}`, s, f] as const))('%s', (_name, s, f) => {
    const graded = gradeAttempt(s, attemptOf(s, f.selections))
    const misses = deriveMisses(s, f.selections)
    const of = (kind: Miss['kind']) => misses.filter((m) => m.kind === kind)
    const actionIds = new Set(s.phases.flatMap((p) => p.actions.map((a) => a.id)))
    const unsafeLines = misses.filter((m) => {
      const action = s.phases.flatMap((p) => p.actions).find((a) => a.id === m.rubricItemId)
      const plan = s.planOptions.find((p) => p.id === m.rubricItemId)
      return (m.kind === 'unsafe' || m.kind === 'unnecessary') && Boolean(action?.unsafeReason ?? plan?.unsafeReason)
    })

    expect(of('omission').map((m) => s.omissions.find((o) => o.id === m.rubricItemId)!.feedback)).toEqual(graded.missed)
    expect(of('unnecessary').filter((m) => actionIds.has(m.rubricItemId))).toHaveLength(graded.unnecessary.length)
    expect(unsafeLines).toHaveLength(graded.unsafe.length)
    expect(of('critical').map((m) => s.criticalRules.find((r) => r.id === m.rubricItemId)!.explanation)).toEqual(graded.criticalMessages)
    const chosenDx = f.selections.diagnosis[0]
    expect(of('wrong-diagnosis').map((m) => m.rubricItemId)).toEqual(chosenDx && chosenDx !== s.correctPrimary ? [chosenDx] : [])
  })

  it('only produces rubric items the authoring check knows about', () => {
    for (const { s, f } of cases) {
      const possible = new Set(possibleMissItems(s))
      for (const m of deriveMisses(s, f.selections, 'unsure')) expect(possible.has(m.rubricItemId)).toBe(true)
    }
  })
})

describe('guessed-correct', () => {
  const s = byId('respiratory')
  const happy = pkg.fixtures.respiratory.fixtures.find((f) => f.kind === 'happy-path')!.selections
  const wrong = pkg.fixtures.respiratory.fixtures.find((f) => f.kind === 'wrong-path')!.selections
  const guessed = (sel: Record<PhaseId, string[]>, c?: 'sure' | 'unsure' | null) => deriveMisses(s, sel, c).filter((m) => m.kind === 'guessed-correct')

  it('is a miss when the correct diagnosis is recorded as unsure', () => {
    expect(guessed(happy, 'unsure')).toEqual([{ rubricItemId: GUESSED_CORRECT_ITEM, kind: 'guessed-correct', phase: 'diagnosis', label: expect.any(String) }])
  })
  it('is not a miss when sure, or when confidence was skipped', () => {
    expect(guessed(happy, 'sure')).toEqual([])
    expect(guessed(happy, undefined)).toEqual([])
    expect(guessed(happy, null)).toEqual([])
  })
  it('never applies to a wrong diagnosis, which is its own miss', () => {
    expect(guessed(wrong, 'unsure')).toEqual([])
    expect(deriveMisses(s, wrong, 'unsure').some((m) => m.kind === 'wrong-diagnosis')).toBe(true)
  })
  it('does not change the grade', () => {
    expect(gradeAttempt(s, attemptOf(s, happy))).toEqual(gradeAttempt(s, attemptOf(s, happy)))
  })
})

describe('classifyMiss', () => {
  const s = byId('respiratory')
  const miss = (m: Partial<Miss>): Miss => ({ rubricItemId: 'x', kind: 'omission', phase: 'history', label: 'x', ...m })

  it('applies the default rules in order', () => {
    expect(classifyMiss(miss({ kind: 'critical' }), [], s)).toBe('unsafe-action')
    expect(classifyMiss(miss({ kind: 'unsafe', phase: 'treatment' }), [], s)).toBe('unsafe-action')
    expect(classifyMiss(miss({ kind: 'guessed-correct', phase: 'diagnosis' }), [], s)).toBe('guessed-correct')
    expect(classifyMiss(miss({ rubricItemId: 'omit-redflags' }), [], s)).toBe('data-gathering-omission')
    expect(classifyMiss(miss({ kind: 'unnecessary', phase: 'diagnostics' }), [], s)).toBe('knowledge-gap')
    expect(classifyMiss(miss({ kind: 'omission', phase: 'treatment' }), [], s)).toBe('knowledge-gap')
  })

  it('separates premature closure from interpretation error', () => {
    const wrong = miss({ kind: 'wrong-diagnosis', phase: 'diagnosis', rubricItemId: 'strep' })
    expect(classifyMiss(wrong, [wrong, miss({ rubricItemId: 'omit-redflags', phase: 'history' })], s)).toBe('premature-closure')
    expect(classifyMiss(wrong, [wrong], s)).toBe('interpretation-error')
  })

  it('classifies an omission scored mainly on communication as a communication lapse', () => {
    const custom: ScenarioDefinition = { ...s, omissions: [{ id: 'omit-x', phase: 'history', label: 'x', when: [], feedback: 'x', effects: [{ category: 'communication', points: -8 }] }] }
    expect(classifyMiss(miss({ rubricItemId: 'omit-x' }), [], custom)).toBe('communication-lapse')
  })

  it('lets an authored mapping override the default', () => {
    expect(classifyMiss(miss({ kind: 'unsafe' }), [], s, { kcIds: ['k'], errorType: 'communication-lapse' })).toBe('communication-lapse')
  })
})
