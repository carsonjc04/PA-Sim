import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PublicAnalyticsDashboard, ReviewSessionResponse, SubmitReviewResponse } from '../../src/api/contracts'
import type { EvidenceRef } from '../../src/domain/analytics/types'
import type { PhaseId } from '../../src/domain/types'
import { createApp } from '../app'
import { devAuthProvider, setAuthProvider } from '../auth/context'
import { contentPackage } from '../content/scenarios'
import { setClock } from '../lib/clock'
import { setSchedulerForTests } from '../review/scheduler'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'

type Selections = Record<PhaseId, string[]>

let db: TestDatabase
let app: Server
const TZ = 'America/Denver'
const pkg = contentPackage()
const fixture = (scenarioId: string, kind: string): Selections => structuredClone(pkg.fixtures[scenarioId].fixtures.find((f) => f.kind === kind)!.selections)
let keySeq = 0
const nextKey = () => `analytics-key-${(keySeq += 1).toString().padStart(5, '0')}`

// Wednesday 2026-10-07 15:00 MDT.
let clock = new Date('2026-10-07T21:00:00Z')
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}
const MIN = 60_000

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
  clock = new Date('2026-10-07T21:00:00Z')
  setClock(() => clock)
})
afterEach(() => {
  setClock(null)
  setSchedulerForTests(null)
})

const toolFor: Record<string, string> = { history: 'record_history_topics', exam: 'request_physical_exam', diagnostics: 'order_diagnostic_test' }
const planToolFor: Record<string, string> = {
  treatment: 'propose_treatment_plan',
  counseling: 'propose_treatment_plan',
  disposition: 'record_disposition',
  'follow-up': 'record_follow_up',
  return: 'record_follow_up',
}

const as = (user: string) => {
  const r = () => request(app)
  return {
    start: (scenarioId: string) => r().post('/api/attempts').set('X-Dev-User', user).send({ scenarioId }),
    event: (id: string, body: object, key = nextKey()) => r().post(`/api/attempts/${id}/events`).set('X-Dev-User', user).set('Idempotency-Key', key).send(body),
    submit: (id: string) => r().post(`/api/attempts/${id}/submit`).set('X-Dev-User', user),
    session: () => r().post('/api/review/sessions').set('X-Dev-User', user).send({ mode: 'all', timeZone: TZ }),
    review: (cardId: string, body: object, key = nextKey()) => r().post(`/api/review/cards/${cardId}/reviews`).set('X-Dev-User', user).set('Idempotency-Key', key).send(body),
    dashboard: (query: Record<string, string> = { timeZone: TZ }) => r().get('/api/analytics/dashboard').query(query).set('X-Dev-User', user),
  }
}

const ok = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBe(200)

async function dashboard(user: string, timeZone = TZ): Promise<PublicAnalyticsDashboard> {
  const res = await as(user).dashboard({ timeZone })
  ok(res)
  return res.body
}

/** Plays a case through the guided API, a minute per step, and submits it. Returns the attempt id. */
async function play(user: string, scenarioId: string, sel: Selections, options: { confidence?: 'sure' | 'unsure'; firstDiagnosis?: string } = {}): Promise<string> {
  const client = as(user)
  const started = await client.start(scenarioId)
  expect(started.status, JSON.stringify(started.body)).toBeLessThan(300)
  const id = started.body.attempt.id as string
  for (const phase of ['history', 'exam', 'diagnostics'] as const) {
    advance(MIN)
    if (sel[phase].length) ok(await client.event(id, { type: 'action', tool: toolFor[phase], actionIds: sel[phase] }))
    ok(await client.event(id, { type: 'lock_phase', phase }))
  }
  advance(MIN)
  if (options.firstDiagnosis) {
    ok(await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: [options.firstDiagnosis], confirmed: true }))
    advance(MIN)
  }
  ok(await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: sel.diagnosis, confirmed: true, ...(options.confidence ? { confidence: options.confidence } : {}) }))
  ok(await client.event(id, { type: 'lock_phase', phase: 'diagnosis' }))
  const scenario = pkg.scenarios.find((s) => s.id === scenarioId)!
  for (const optionId of sel.treatment) {
    const group = scenario.planOptions.find((p) => p.id === optionId)!.group
    ok(await client.event(id, { type: 'action', tool: planToolFor[group], actionIds: [optionId], confirmed: true }))
  }
  advance(MIN)
  ok(await client.submit(id))
  return id
}

const withoutRedFlags = () => {
  const sel = fixture('respiratory', 'happy-path')
  sel.history = sel.history.filter((id) => id !== 'redflags')
  return sel
}

/** Every evidence reference anywhere in the dashboard. */
function refs(value: unknown): EvidenceRef[] {
  if (Array.isArray(value)) return value.flatMap(refs)
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.source === 'string' && typeof v.id === 'string' && typeof v.at === 'string') return [v as unknown as EvidenceRef]
    return Object.values(v).flatMap(refs)
  }
  return []
}

const TABLE: Record<EvidenceRef['source'], string> = {
  attempt: 'SELECT submitted_at AS at FROM attempts a JOIN users u ON u.id = a.user_id WHERE a.id = $1::uuid AND u.external_subject = $2',
  attempt_event: 'SELECT e.created_at AS at FROM attempt_events e JOIN attempts a ON a.id = e.attempt_id JOIN users u ON u.id = a.user_id WHERE e.id = $1::bigint AND u.external_subject = $2',
  remediation_evidence: 'SELECT e.created_at AS at FROM remediation_evidence e JOIN users u ON u.id = e.user_id WHERE e.id = $1::uuid AND u.external_subject = $2',
  learning_event: 'SELECT e.at FROM learning_events e JOIN users u ON u.id = e.user_id WHERE e.id = $1::bigint AND u.external_subject = $2',
}

const stable = (d: PublicAnalyticsDashboard) => ({ ...d, generatedAt: 'x' })

describe('GET /api/analytics/dashboard', () => {
  it('requires a signed-in learner and a valid zone and blueprint', async () => {
    expect((await request(app).get('/api/analytics/dashboard').query({ timeZone: TZ })).status).toBe(401)
    expect((await as('alice').dashboard({})).status).toBe(400)
    expect((await as('alice').dashboard({ timeZone: 'Mars/Olympus' })).status).toBe(400)
    expect((await as('alice').dashboard({ timeZone: TZ, extra: '1' })).status).toBe(400)
    const missing = await as('alice').dashboard({ timeZone: TZ, blueprint: 'no-such-blueprint' })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('blueprint_not_found')
  })

  it('starts empty: no rates, coverage gaps as priorities, and no readiness estimate', async () => {
    const d = await dashboard('alice')
    expect(d.totals).toEqual({ analyzedAttempts: 0, distinctCases: 0, notYetAnalyzed: 0 })
    expect(d.blueprint).toEqual({ id: 'nccpa-pance-2025', label: 'PANCE' })
    expect(d.priorities.length).toBeGreaterThan(0)
    expect(d.priorities.every((p) => p.kind === 'coverage-gap')).toBe(true)
    expect(d.areas.every((a) => a.proficiency.value === null && a.proficiency.sufficiency === 'none')).toBe(true)
    expect(d.trend.buckets).toEqual([])
    expect(d.readiness).toMatchObject({ available: false, protocol: 'docs/readiness-calibration-protocol.md' })
    expect(d.metricVersions['recommendation.priorities']).toBe(1)
  })

  it('traces every statement to a stored row the learner owns', async () => {
    await play('alice', 'respiratory', withoutRedFlags(), { confidence: 'unsure', firstDiagnosis: 'strep' })
    await play('alice', 'respiratory', fixture('respiratory', 'critical-safety-miss'))
    await play('alice', 'asthma', fixture('asthma', 'partial-credit'))
    const d = await dashboard('alice')
    expect(d.totals.analyzedAttempts).toBe(3)
    const all = refs(d)
    expect(all.length).toBeGreaterThan(5)
    for (const ref of all) {
      const { rows } = await db.pool.query(TABLE[ref.source], [ref.id, 'alice'])
      expect(rows, `${ref.source} ${ref.id}`).toHaveLength(1)
      expect(new Date(rows[0].at).toISOString()).toBe(ref.at)
    }
    for (const p of d.priorities) {
      expect(p.why.length).toBeGreaterThan(0)
      expect(p.nextAction.href).toMatch(/^\/(encounter|review|results)/)
      if (p.kind !== 'coverage-gap' && p.kind !== 'due-retrieval') expect(p.evidence.length).toBeGreaterThan(0)
    }
  })

  it('keeps each learner’s analytics to themselves', async () => {
    await play('alice', 'respiratory', withoutRedFlags())
    const bob = await dashboard('bob')
    expect(bob.totals.analyzedAttempts).toBe(0)
    expect(refs(bob)).toEqual([])
  })
})

describe('event semantics', () => {
  it('times decisions with the server clock and records a replaced diagnosis as a change', async () => {
    const id = await play('alice', 'respiratory', fixture('respiratory', 'happy-path'), { firstDiagnosis: 'strep' })
    const d = await dashboard('alice')
    expect(d.decision).toMatchObject({ attempts: 1, attemptsWithDiagnosisChange: 1, diagnosisChanges: 1, sufficiency: 'insufficient' })
    // One attempt is not enough to report a typical time; the sample is still counted.
    expect(d.decision.firstDiagnosis).toMatchObject({ n: 1, medianMs: null })
    const { rows } = await db.pool.query(
      `SELECT e.created_at - a.created_at AS gap FROM attempt_events e JOIN attempts a ON a.id = e.attempt_id
       WHERE a.id = $1 AND e.phase = 'diagnosis' AND e.type = 'action' ORDER BY e.seq LIMIT 1`,
      [id],
    )
    expect(rows[0].gap).toMatchObject({ minutes: 4 })
  })

  it('records a change of confidence on the same diagnosis', async () => {
    const client = as('alice')
    const id = (await client.start('respiratory')).body.attempt.id as string
    for (const phase of ['history', 'exam', 'diagnostics']) ok(await client.event(id, { type: 'lock_phase', phase }))
    ok(await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: ['viral-uri'], confirmed: true, confidence: 'unsure' }))
    advance(MIN)
    ok(await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: ['viral-uri'], confirmed: true, confidence: 'sure' }))
    ok(await client.submit(id))
    expect((await dashboard('alice')).decision).toMatchObject({ confidenceChanges: 1, diagnosisChanges: 0 })
  })

  it('is unchanged by retried requests that reuse an Idempotency-Key', async () => {
    const client = as('alice')
    const id = (await client.start('respiratory')).body.attempt.id as string
    const body = { type: 'action', tool: 'record_history_topics', actionIds: ['fever'] }
    ok(await client.event(id, body, 'retry-key-1'))
    ok(await client.event(id, body, 'retry-key-1'))
    expect(Number((await db.pool.query(`SELECT count(*) AS n FROM attempt_events WHERE attempt_id = $1 AND action_id = 'fever'`, [id])).rows[0].n)).toBe(1)
    // Resubmitting a submitted attempt returns the stored result; nothing is counted twice.
    const played = await play('alice', 'asthma', fixture('asthma', 'partial-credit'))
    const before = await dashboard('alice')
    ok(await client.submit(played))
    expect(stable(await dashboard('alice'))).toEqual(stable(before))
  })

  it('counts a retracted then reselected action once', async () => {
    const client = as('alice')
    const id = (await client.start('respiratory')).body.attempt.id as string
    const sel = fixture('respiratory', 'happy-path')
    ok(await client.event(id, { type: 'action', tool: 'record_history_topics', actionIds: ['redflags'] }))
    ok(await client.event(id, { type: 'retract', phase: 'history', actionId: 'redflags' }))
    ok(await client.event(id, { type: 'action', tool: 'record_history_topics', actionIds: sel.history }))
    for (const phase of ['history', 'exam', 'diagnostics'] as const) {
      if (phase !== 'history' && sel[phase].length) ok(await client.event(id, { type: 'action', tool: toolFor[phase], actionIds: sel[phase] }))
      ok(await client.event(id, { type: 'lock_phase', phase }))
    }
    ok(await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: sel.diagnosis, confirmed: true }))
    ok(await client.event(id, { type: 'lock_phase', phase: 'diagnosis' }))
    for (const optionId of sel.treatment) {
      const group = pkg.scenarios.find((s) => s.id === 'respiratory')!.planOptions.find((p) => p.id === optionId)!.group
      ok(await client.event(id, { type: 'action', tool: planToolFor[group], actionIds: [optionId], confirmed: true }))
    }
    ok(await client.submit(id))
    const d = await dashboard('alice')
    expect(d.errorTypes).toEqual([])
    expect(d.areas.find((a) => a.id === 'history-taking-physical-examination')!.proficiency).toMatchObject({ successes: 1, n: 1 })
  })

  it('counts a retried review rating once in retention', async () => {
    await play('alice', 'respiratory', withoutRedFlags(), { confidence: 'sure' })
    const first = (await as('alice').session()).body as ReviewSessionResponse
    const item = first.session!.items[0]
    const rated = (await as('alice').review(item.cardId, { sessionId: first.session!.id, promptId: item.prompt.id, rating: 3 })).body as SubmitReviewResponse
    clock = new Date(Date.parse(rated.nextDue) + MIN)
    const second = (await as('alice').session()).body as ReviewSessionResponse
    const again = second.session!.items[0]
    const body = { sessionId: second.session!.id, promptId: again.prompt.id, rating: 3 }
    ok(await as('alice').review(again.cardId, body, 'review-retry-1'))
    ok(await as('alice').review(again.cardId, body, 'review-retry-1'))
    const d = await dashboard('alice')
    expect(d.retention.recall).toMatchObject({ n: 1, successes: 1, sufficiency: 'insufficient', value: null })
  })

  it('places a submission in the study week of the learner’s zone', async () => {
    // Monday 2026-10-12 03:30 MDT is still Sunday's study day in Denver, but Monday 18:30 in Tokyo.
    clock = new Date('2026-10-12T09:20:00Z')
    await play('alice', 'asthma', fixture('asthma', 'happy-path'))
    expect((await dashboard('alice', 'America/Denver')).trend.buckets.map((b) => b.weekStart)).toEqual(['2026-10-05'])
    expect((await dashboard('alice', 'Asia/Tokyo')).trend.buckets.map((b) => b.weekStart)).toEqual(['2026-10-12'])
  })

  it('leaves clean attempts derived under a superseded remediation mapping out of objective denominators', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'happy-path'), { confidence: 'sure' })
    const current = await dashboard('alice')
    expect(current.objectives.length).toBeGreaterThan(0)
    expect(current.objectives.every((o) => o.attempts === 1 && o.attemptsWithMiss === 0)).toBe(true)
    await db.pool.query(`UPDATE remediation_derivations SET remediation_version = '0.0.1'`)
    const superseded = await dashboard('alice')
    expect(superseded.objectives).toEqual([])
    // Area metrics read the pinned case, not the mapping, so they are unaffected.
    expect(stable({ ...superseded, objectives: [] }).areas).toEqual(stable({ ...current, objectives: [] }).areas)
  })

  it('counts submitted attempts whose misses are not derived yet instead of reading them as clean', async () => {
    await play('alice', 'respiratory', withoutRedFlags())
    await db.pool.query('DELETE FROM remediation_evidence')
    await db.pool.query('DELETE FROM remediation_derivations')
    // The dashboard runs the same backfill as review, so the attempt is derived again and counted normally.
    const d = await dashboard('alice')
    expect(d.totals).toMatchObject({ analyzedAttempts: 1, notYetAnalyzed: 0 })
    expect(d.errorTypes.map((e) => e.errorType)).toEqual(['data-gathering-omission'])
  })
})
