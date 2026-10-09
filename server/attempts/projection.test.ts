import { describe, expect, it } from 'vitest'
import { scenarios } from '../../src/data/scenarios'
import { gradeAttempt } from '../../src/domain/grading'
import type { ScenarioDefinition } from '../../src/domain/types'
import { toPublicAttempt, toPublicScenario } from './projection'
import type { AttemptRow, EventRow } from './repository'

function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key)
      collectKeys(child, into)
    }
  }
  return into
}

const scenario = scenarios.find((s) => s.id === 'chest-pressure') as ScenarioDefinition
const attempt = (status: 'active' | 'submitted'): AttemptRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  scenarioId: scenario.id,
  contentVersionId: `${scenario.id}@abcdef123456`,
  status,
  currentPhase: 'history',
  lockedPhases: [],
  createdAt: '2026-10-09T00:00:00.000Z',
  submittedAt: status === 'submitted' ? '2026-10-09T00:10:00.000Z' : null,
})
const events: EventRow[] = [
  { seq: 1, type: 'live_started', phase: 'history', actionId: null, kind: null, confirmed: false, revealed: null, source: 'system', createdAt: '2026-10-09T00:00:01.000Z' },
]

describe('public projection withholds the answer key', () => {
  it('omits every scoring and answer-key field before submit', () => {
    const keys = collectKeys(toPublicAttempt(attempt('active'), scenario, events, null))
    for (const forbidden of ['correctPrimary', 'criticalRules', 'omissions', 'idealPlan', 'teachingPoints', 'effects', 'unsafe', 'unsafeReason', 'reasoning', 'response', 'rule', 'detail']) {
      expect(keys.has(forbidden), `public payload leaked "${forbidden}"`).toBe(false)
    }
  })

  it('does not leak hidden text anywhere in the serialized payload', () => {
    const projected = toPublicScenario(scenario)
    const serialized = JSON.stringify(toPublicAttempt(attempt('active'), scenario, events, null))

    // A secret that is a substring of a public option label reveals nothing, because every option is shown.
    const publicText = [
      ...projected.phases.flatMap((p) => p.actions.flatMap((a) => [a.label, a.paText])),
      ...projected.diagnoses.map((d) => d.label),
      ...projected.planOptions.map((p) => p.label),
    ]
    const isPublic = (text: string) => publicText.some((candidate) => candidate.includes(text))
    const secrets = [
      ...scenario.criticalRules.map((r) => r.explanation),
      ...scenario.idealPlan,
      ...scenario.teachingPoints,
      ...scenario.omissions.map((o) => o.feedback),
      ...scenario.diagnoses.map((d) => d.reasoning).filter((r): r is string => Boolean(r)),
      ...scenario.phases.flatMap((p) => p.actions.map((a) => a.response)),
    ].filter((secret) => !isPublic(secret))

    expect(secrets.length, 'expected real secrets to scan').toBeGreaterThan(0)
    for (const secret of secrets) expect(serialized.includes(secret), `public payload leaked: "${secret}"`).toBe(false)
  })

  it('does not mark which diagnosis is correct', () => {
    const projected = toPublicScenario(scenario)
    expect(projected.diagnoses.every((d) => Object.keys(d).sort().join(',') === 'id,label')).toBe(true)
  })

  it('omits the debrief for an active attempt even if a result row exists', () => {
    const graded = gradeAttempt(scenario, { id: 'x', scenarioId: scenario.id, startedAt: '', selectedByPhase: { history: [], exam: [], diagnostics: [], diagnosis: [scenario.correctPrimary], treatment: [] }, phaseLocks: [], revealed: [], submitted: true })
    const stored = { gradingVersionId: 'g', contentVersionId: 'c', inputDigest: 'd', result: graded, createdAt: '2026-10-09T00:00:00.000Z' }
    expect(toPublicAttempt(attempt('active'), scenario, events, stored).debrief).toBeNull()
    expect(toPublicAttempt(attempt('submitted'), scenario, events, stored).debrief?.finalScore).toBe(graded.finalScore)
  })

  it('never exposes system events such as live session details', () => {
    expect(toPublicAttempt(attempt('active'), scenario, events, null).events).toEqual([])
  })
})
