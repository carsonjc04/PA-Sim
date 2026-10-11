import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PublicAttempt } from '../../src/api/contracts'
import { gradeAttempt } from '../../src/domain/grading'
import { phaseOrder, type PhaseId, type ScenarioDefinition } from '../../src/domain/types'
import { createApp } from '../app'
import { devAuthProvider, setAuthProvider } from '../auth/context'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'
import { contentPackage } from './scenarios'

const pkg = contentPackage()
let app: Server
let db: TestDatabase
let seq = 0
const key = () => `playthrough-${(seq += 1).toString().padStart(5, '0')}`

beforeAll(async () => {
  db = await createTestDatabase()
  app = await listenLocal(createApp())
})
afterAll(async () => {
  await closeLocalServers()
  await db.close()
})
beforeEach(async () => {
  await db.reset()
  setAuthProvider(devAuthProvider)
})

const toolFor = (scenario: ScenarioDefinition, phase: PhaseId, id: string) => {
  if (phase === 'history') return 'record_history_topics'
  if (phase === 'exam') return 'request_physical_exam'
  if (phase === 'diagnostics') return 'order_diagnostic_test'
  if (phase === 'diagnosis') return 'propose_diagnosis'
  const group = scenario.planOptions.find((p) => p.id === id)!.group
  return group === 'disposition' ? 'record_disposition' : group === 'follow-up' || group === 'return' ? 'record_follow_up' : 'propose_treatment_plan'
}

/** Drives a whole encounter over HTTP: record every selection, lock each phase, submit. */
async function play(scenario: ScenarioDefinition, selections: Record<PhaseId, string[]>, user = 'alice') {
  const post = (path: string, body?: object, idem?: string) => {
    const r = request(app).post(path).set('X-Dev-User', user)
    return (idem ? r.set('Idempotency-Key', idem) : r).send(body)
  }
  const start = await post('/api/attempts', { scenarioId: scenario.id })
  const attempt = start.body.attempt as PublicAttempt
  const reveals: string[] = []
  for (const phase of phaseOrder) {
    for (const id of selections[phase]) {
      const res = await post(`/api/attempts/${attempt.id}/events`, { type: 'action', tool: toolFor(scenario, phase, id), actionIds: [id], confirmed: true }, key())
      expect(res.status, `${scenario.id} ${phase}/${id}: ${JSON.stringify(res.body)}`).toBe(200)
      reveals.push(...(res.body.result.reveals as { text: string }[]).map((r) => r.text))
    }
    if (phase !== 'treatment') await post(`/api/attempts/${attempt.id}/events`, { type: 'lock_phase', phase }, key())
  }
  const submitted = await post(`/api/attempts/${attempt.id}/submit`)
  return { id: attempt.id, status: submitted.status, body: submitted.body as PublicAttempt, reveals }
}

describe.each(pkg.scenarios.map((s) => [s.id, s] as const))('playthrough: %s', (id, scenario) => {
  const file = pkg.fixtures[id]

  it('has all four graded fixture kinds', () => {
    expect(file.fixtures.map((f) => f.kind).sort()).toEqual(['critical-safety-miss', 'happy-path', 'partial-credit', 'wrong-path'])
  })

  it.each(file.fixtures.map((f) => [f.kind, f] as const))('%s: HTTP result equals the authored expectation and the pure grader', async (_kind, fx) => {
    const run = await play(scenario, fx.selections)
    expect(run.status).toBe(200)
    const d = run.body.debrief!
    const pure = gradeAttempt(scenario, { id: 'p', scenarioId: id, startedAt: '1970-01-01', selectedByPhase: fx.selections, phaseLocks: [], revealed: [], submitted: true })

    expect({ rawScore: d.rawScore, finalScore: d.finalScore, passed: d.passed, criticalSafetyError: d.criticalSafetyError, missedCount: d.missed.length, unsafeCount: d.unsafe.length }).toEqual(fx.expect)
    expect(d.categoryScores).toEqual(pure.categoryScores)
    expect(d.finalScore).toBe(pure.finalScore)
    if (fx.kind === 'critical-safety-miss' && scenario.criticalRules.length) {
      expect(d.criticalMessages.length).toBeGreaterThan(0)
      expect(d.finalScore).toBeLessThanOrEqual(59)
    }
    if (fx.kind === 'wrong-path') expect(d.strengths.join(' ')).not.toContain('Primary diagnosis aligned')
    if (fx.kind === 'happy-path') expect(d.strengths.join(' ')).toContain('Primary diagnosis aligned')
    expect(d.gradingVersionId).toBe(pkg.manifest.gradingVersion)
    expect(d.contentVersionId).toMatch(new RegExp(`^${id}@[0-9a-f]{12}$`))
  })

  it('is deterministic: replaying a fixture gives the same result', async () => {
    const fx = file.fixtures[0]
    const a = (await play(scenario, fx.selections, 'alice')).body.debrief!
    const b = (await play(scenario, fx.selections, 'bob')).body.debrief!
    expect({ ...a, gradedAt: '' }).toEqual({ ...b, gradedAt: '' })
  })
})

describe('hidden-state leakage', () => {
  const forbiddenKeys = ['correctPrimary', 'criticalRules', 'criticalWaivers', 'spoilerTerms', 'omissions', 'teachingPoints', 'effects', 'unsafe', 'unsafeReason', 'reasoning', 'response', 'rule', 'definition', 'idealPlan', 'lifecycle', 'reviews', 'reviewerRole', 'openItems', 'changeLog', 'taxonomy', 'nextReviewDue', 'verified', 'notes', 'specificity', 'accessedAt']

  const keysOf = (value: unknown, into = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) value.forEach((v) => keysOf(v, into))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
      into.add(k)
      keysOf(v, into)
    }
    return into
  }
  const secrets = (s: ScenarioDefinition) => {
    const publicText = ([...s.phases.flatMap((p) => p.actions.flatMap((a) => [a.label, a.paText])), ...s.diagnoses.map((d) => d.label), ...s.planOptions.map((p) => p.label)])
    return [
      ...s.teachingPoints,
      ...s.idealPlan,
      ...s.omissions.map((o) => o.feedback),
      ...s.criticalRules.map((r) => r.explanation),
      ...s.diagnoses.map((d) => d.reasoning ?? ''),
      ...s.planOptions.map((p) => p.unsafeReason ?? ''),
      ...s.phases.flatMap((p) => p.actions.flatMap((a) => [a.unsafeReason ?? '', a.response])),
      ...s.clinicalReferences.map((r) => r.notes ?? ''),
      ...s.lifecycle.openItems,
      ...s.lifecycle.changeLog.map((c) => c.summary),
    ].filter((t) => t.length > 12 && !publicText.some((label) => label.includes(t)))
  }

  it.each(pkg.scenarios.map((s) => [s.id, s] as const))('%s: no learner payload carries answer-key or maintainer fields before submit', async (_id, scenario) => {
    const catalogue = await request(app).get('/api/scenarios')
    const entry = (catalogue.body as { id: string }[]).find((s) => s.id === scenario.id)
    const start = await request(app).post('/api/attempts').set('X-Dev-User', 'alice').send({ scenarioId: scenario.id })
    const first = scenario.phases[0].actions[0]
    const act = await request(app)
      .post(`/api/attempts/${start.body.attempt.id}/events`)
      .set('X-Dev-User', 'alice')
      .set('Idempotency-Key', key())
      .send({ type: 'action', tool: 'record_history_topics', actionIds: [first.id] })
    const detail = await request(app).get(`/api/attempts/${start.body.attempt.id}`).set('X-Dev-User', 'alice')
    const history = await request(app).get('/api/attempts').set('X-Dev-User', 'alice')

    // The one action that was recorded may release its own response; nothing else may appear.
    const allowed = first.response
    for (const [name, payload] of [['catalogue entry', entry], ['start', start.body], ['event', act.body], ['detail', detail.body], ['history', history.body]] as const) {
      const keys = keysOf(payload)
      for (const k of forbiddenKeys) expect(keys.has(k), `${name} leaked key "${k}"`).toBe(false)
      const text = JSON.stringify(payload).replaceAll(JSON.stringify(allowed).slice(1, -1), '')
      for (const secret of secrets(scenario)) expect(text.includes(JSON.stringify(secret).slice(1, -1)), `${name} leaked "${secret.slice(0, 40)}"`).toBe(false)
    }
    // Unrun actions in the current phase stay withheld.
    const others = scenario.phases[0].actions.slice(1)
    const text = JSON.stringify(detail.body)
    for (const a of others) expect(text.includes(JSON.stringify(a.response).slice(1, -1))).toBe(false)
  })

  it('exposes only a coarse review label and provenance to learners', async () => {
    const catalogue = (await request(app).get('/api/scenarios')).body as { reviewStatus: string; clinicalReferences: Record<string, unknown>[] }[]
    expect(catalogue).toHaveLength(5)
    for (const s of catalogue) {
      expect(s.reviewStatus).toBe('requires-clinician-review')
      for (const r of s.clinicalReferences) expect(Object.keys(r).sort()).toEqual(['organization', 'title', 'url'])
    }
  })

  it('releases the answer key only in the post-submit debrief, and never maintainer data', async () => {
    const scenario = pkg.scenarios.find((s) => s.id === 'chest-pressure')!
    const run = await play(scenario, pkg.fixtures['chest-pressure'].fixtures[0].selections)
    const keys = keysOf(run.body)
    for (const k of ['lifecycle', 'reviews', 'reviewerRole', 'openItems', 'taxonomy', 'criticalWaivers', 'spoilerTerms', 'definition']) expect(keys.has(k), `debrief leaked "${k}"`).toBe(false)
    expect(run.body.debrief?.diagnosisReasoning).toBeTruthy()
  })
})
