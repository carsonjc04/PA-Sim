import { beforeEach, describe, expect, it } from 'vitest'
import { createEncounter, getScenario, resetEncounters } from './store'
import { toPublicEncounter, toPublicScenario } from './projection'

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

const newEncounter = (scenarioId: string) =>
  createEncounter({
    scenarioId,
    studentId: 'mock-student',
    mode: 'voice-handcrafted',
    liveModel: 'gpt-live-1',
    reasoningModel: 'gpt-5.6-sol',
  })

describe('public projection withholds the answer key', () => {
  beforeEach(resetEncounters)

  it('omits every scoring and answer-key field', () => {
    const keys = collectKeys(toPublicEncounter(newEncounter('chest-pressure')))
    for (const forbidden of [
      'correctPrimary',
      'criticalRules',
      'omissions',
      'idealPlan',
      'teachingPoints',
      'effects',
      'unsafe',
      'unsafeReason',
      'reasoning',
      'response',
      'rule',
      'hidden',
    ]) {
      expect(keys.has(forbidden), `public payload leaked "${forbidden}"`).toBe(false)
    }
  })

  it('does not leak hidden text anywhere in the serialized payload', () => {
    const scenario = getScenario('chest-pressure')
    const projected = toPublicScenario(scenario)
    const serialized = JSON.stringify(toPublicEncounter(newEncounter('chest-pressure')))

    // Option labels and prompts are intentionally public. A secret that merely
    // reads as a substring of one of them ("Activate EMS" inside "Activate EMS
    // and arrange emergency transfer") reveals nothing, because every option is
    // shown. Only text carrying information beyond that set is a real leak.
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
      // No action response may appear before the student performs that action.
      ...scenario.phases.flatMap((p) => p.actions.map((a) => a.response)),
    ].filter((secret) => !isPublic(secret))

    expect(secrets.length, 'expected real secrets to scan').toBeGreaterThan(0)
    for (const secret of secrets) {
      expect(serialized.includes(secret), `public payload leaked: "${secret}"`).toBe(false)
    }
  })

  it('still exposes what the student legitimately needs', () => {
    const scenario = getScenario('chest-pressure')
    const projected = toPublicScenario(scenario)
    expect(projected.opening).toBe(scenario.opening)
    expect(projected.diagnoses).toHaveLength(scenario.diagnoses.length)
    expect(projected.phases[0].actions.length).toBeGreaterThan(0)
    expect(projected.phases[0].actions[0].paText).toBeTruthy()
  })

  it('does not mark which diagnosis is correct', () => {
    const projected = toPublicScenario(getScenario('chest-pressure'))
    expect(projected.diagnoses.every((d) => Object.keys(d).sort().join(',') === 'id,label')).toBe(true)
  })
})
