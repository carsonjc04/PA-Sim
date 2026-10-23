import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PublicAttempt } from '../../src/api/contracts'
import { scenarios } from '../content/scenarios'
import type { ScenarioDefinition } from '../../src/domain/types'
import { createApp } from '../app'
import { noAuthProvider, setAuthProvider, devAuthProvider } from '../auth/context'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'

let db: TestDatabase
let app: Server
const scenario = scenarios.find((s) => s.id === 'chest-pressure') as ScenarioDefinition
const firstAction = (phase: string) => scenario.phases.find((p) => p.id === phase)!.actions[0]
let keySeq = 0
const nextKey = () => `test-key-${(keySeq += 1).toString().padStart(4, '0')}`

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

const as = (user: string) => ({
  start: (scenarioId = 'chest-pressure') => request(app).post('/api/attempts').set('X-Dev-User', user).send({ scenarioId }),
  get: (id: string) => request(app).get(`/api/attempts/${id}`).set('X-Dev-User', user),
  history: (query = '') => request(app).get(`/api/attempts${query}`).set('X-Dev-User', user),
  event: (id: string, body: object, key = nextKey()) =>
    request(app).post(`/api/attempts/${id}/events`).set('X-Dev-User', user).set('Idempotency-Key', key).send(body),
  submit: (id: string) => request(app).post(`/api/attempts/${id}/submit`).set('X-Dev-User', user),
})

async function completeAttempt(user: string, options: { unsafe?: boolean } = {}): Promise<string> {
  const client = as(user)
  const { body } = await client.start()
  const id = body.attempt.id as string
  await client.event(id, { type: 'action', tool: 'record_history_topics', actionIds: [firstAction('history').id] })
  for (const phase of ['history', 'exam', 'diagnostics']) await client.event(id, { type: 'lock_phase', phase })
  await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: [scenario.correctPrimary], confirmed: true })
  await client.event(id, { type: 'lock_phase', phase: 'diagnosis' })
  if (options.unsafe) {
    const unsafe = scenario.planOptions.find((p) => p.unsafe)!
    const tool = unsafe.group === 'disposition' ? 'record_disposition' : 'propose_treatment_plan'
    await client.event(id, { type: 'action', tool, actionIds: [unsafe.id], confirmed: true })
  }
  return id
}

function hiddenStrings(s: ScenarioDefinition): string[] {
  const publicLabels = [
    ...s.phases.flatMap((p) => p.actions.flatMap((a) => [a.label, a.paText])),
    ...s.diagnoses.map((d) => d.label),
    ...s.planOptions.map((p) => p.label),
  ]
  return [
    ...s.criticalRules.map((r) => r.explanation),
    ...s.teachingPoints,
    ...s.omissions.map((o) => o.feedback),
    ...s.diagnoses.map((d) => d.reasoning ?? ''),
    ...s.idealPlan,
    ...s.planOptions.map((p) => p.unsafeReason ?? ''),
    ...s.phases.flatMap((p) => p.actions.map((a) => a.unsafeReason ?? '')),
  ].filter((text) => text.length > 0 && !publicLabels.some((label) => label.includes(text)))
}

const forbiddenKeys = ['correctPrimary', 'criticalRules', 'omissions', 'teachingPoints', 'effects', 'unsafe', 'unsafeReason', 'reasoning', 'response', 'rule', 'definition', 'weights', 'idealPlan']

function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, into))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k)
      collectKeys(v, into)
    }
  }
  return into
}

describe('authorization', () => {
  it('requires a user on every attempt route', async () => {
    const id = '00000000-0000-4000-8000-000000000000'
    for (const res of await Promise.all([
      request(app).post('/api/attempts').send({ scenarioId: 'chest-pressure' }),
      request(app).get('/api/attempts'),
      request(app).get(`/api/attempts/${id}`),
      request(app).post(`/api/attempts/${id}/events`).set('Idempotency-Key', nextKey()).send({ type: 'lock_phase', phase: 'history' }),
      request(app).post(`/api/attempts/${id}/submit`),
    ])) {
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('auth_required')
    }
  })

  it('refuses everything when no auth provider is configured', async () => {
    setAuthProvider(noAuthProvider)
    const res = await as('alice').start()
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('auth_unavailable')
    const status = await request(app).get('/api/auth/status')
    expect(status.body).toEqual({ provider: 'none', available: false, insecure: false, user: null })
  })

  it('rejects a malformed dev identity', async () => {
    const res = await request(app).get('/api/attempts').set('X-Dev-User', 'Robert"); DROP TABLE users;--')
    expect(res.status).toBe(400)
  })

  it('hides another user\u2019s attempt on every read and write route', async () => {
    const id = await completeAttempt('alice')
    const bob = as('bob')

    for (const res of [
      await bob.get(id),
      await bob.event(id, { type: 'lock_phase', phase: 'treatment' }),
      await bob.submit(id),
    ]) {
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('attempt_not_found')
    }
    expect((await bob.history()).body.items).toEqual([])

    const live = await request(app)
      .post('/api/live/tool')
      .set('X-Dev-User', 'bob')
      .send({ attemptId: id, sessionId: 'live_sess_x', callId: 'call_x', name: 'record_follow_up', arguments: '{"actionIds":["x"]}' })
    expect(live.status).toBe(404)

    // Alice's attempt is untouched by Bob's attempts.
    const own = await as('alice').get(id)
    expect(own.status).toBe(200)
    expect(own.body.currentPhase).toBe('treatment')
  })

  it('reports a malformed attempt ID the same way as a missing one', async () => {
    const res = await as('alice').get('not-a-uuid')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('attempt_not_found')
  })
})

describe('malformed payloads', () => {
  it('returns structured 400s', async () => {
    const alice = as('alice')
    const { body } = await alice.start()
    const id = body.attempt.id

    const cases: [request.Test, string][] = [
      [alice.start('../etc/passwd'), 'invalid_body'],
      [request(app).post('/api/attempts').set('X-Dev-User', 'alice').send({ scenarioId: 'chest-pressure', extra: 1 }), 'invalid_body'],
      [request(app).post('/api/attempts').set('X-Dev-User', 'alice').set('Content-Type', 'application/json').send('{"scenarioId":'), 'invalid_body'],
      [alice.event(id, { type: 'teleport' }), 'invalid_body'],
      [alice.event(id, { type: 'action', tool: 'reveal_diagnosis', actionIds: ['x'] }), 'invalid_body'],
      [alice.event(id, { type: 'action', tool: 'record_history_topics', actionIds: [] }), 'invalid_body'],
      [alice.event(id, { type: 'lock_phase', phase: 'history' }, 'short'), 'invalid_body'],
      [request(app).post(`/api/attempts/${id}/events`).set('X-Dev-User', 'alice').send({ type: 'lock_phase', phase: 'history' }), 'missing_idempotency_key'],
      [alice.history('?limit=500'), 'invalid_query'],
      [alice.history('?cursor=garbage'), 'invalid_query'],
      [alice.history('?sort=score'), 'invalid_query'],
    ]
    for (const [pending, code] of cases) {
      const res = await pending
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.error.code).toBe(code)
      expect(typeof res.body.error.requestId).toBe('string')
    }
    expect((await alice.start('no-such-case')).status).toBe(404)
  })

  it('rejects actions that are unknown, from a later phase, or for the wrong tool', async () => {
    const alice = as('alice')
    const id = (await alice.start()).body.attempt.id
    const unknown = await alice.event(id, { type: 'action', tool: 'record_history_topics', actionIds: ['not-real'] })
    expect(unknown.body.error.code).toBe('unknown_action')
    const later = await alice.event(id, { type: 'action', tool: 'record_history_topics', actionIds: [firstAction('exam').id] })
    expect(later.body.error.code).toBe('unknown_action')
    const wrongTool = await alice.event(id, { type: 'action', tool: 'request_physical_exam', actionIds: [firstAction('exam').id] })
    expect(wrongTool.status).toBe(409)
    expect(wrongTool.body.error.code).toBe('wrong_phase')
  })
})

describe('idempotency', () => {
  it('replays the stored response for a repeated key and records once', async () => {
    const alice = as('alice')
    const id = (await alice.start()).body.attempt.id
    const body = { type: 'action', tool: 'record_history_topics', actionIds: [firstAction('history').id] }
    const first = await alice.event(id, body, 'retry-key-0001')
    const second = await alice.event(id, body, 'retry-key-0001')
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(first.body.result.recorded).toEqual([firstAction('history').id])

    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM attempt_events WHERE attempt_id = $1 AND type = 'action'`, [id])
    expect(rows[0].n).toBe(1)
  })

  it('treats the same action under a new key as a duplicate, not a second score', async () => {
    const alice = as('alice')
    const id = (await alice.start()).body.attempt.id
    const body = { type: 'action', tool: 'record_history_topics', actionIds: [firstAction('history').id] }
    await alice.event(id, body)
    const again = await alice.event(id, body)
    expect(again.body.result).toMatchObject({ recorded: [], duplicates: [firstAction('history').id] })
  })

  it('rejects a reused key with a different body', async () => {
    const alice = as('alice')
    const id = (await alice.start()).body.attempt.id
    await alice.event(id, { type: 'lock_phase', phase: 'history' }, 'reuse-key-0001')
    const conflict = await alice.event(id, { type: 'lock_phase', phase: 'exam' }, 'reuse-key-0001')
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('idempotency_conflict')
  })

  it('serializes concurrent retries of the same request', async () => {
    const alice = as('alice')
    const id = (await alice.start()).body.attempt.id
    const body = { type: 'lock_phase', phase: 'history' }
    const results = await Promise.all([1, 2, 3].map(() => alice.event(id, body, 'race-key-0001')))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(results[1].body).toEqual(results[0].body)
    expect(results[2].body).toEqual(results[0].body)
    expect((await alice.get(id)).body.currentPhase).toBe('exam')
  })

  it('keeps an unconfirmed diagnosis out of the graded log', async () => {
    const alice = as('alice')
    const id = (await alice.start()).body.attempt.id
    for (const phase of ['history', 'exam', 'diagnostics']) await alice.event(id, { type: 'lock_phase', phase })
    const pending = await alice.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: [scenario.correctPrimary], confirmed: false })
    expect(pending.body.result.pendingConfirmation).toEqual([scenario.correctPrimary])
    expect(pending.body.attempt.events).toHaveLength(0)
    expect((await alice.submit(id)).body.error.code).toBe('diagnosis_required')
  })
})

describe('submit', () => {
  it('grades once and returns the identical stored result on repeat and concurrent submits', async () => {
    const id = await completeAttempt('alice', { unsafe: true })
    const alice = as('alice')
    const [a, b, c] = await Promise.all([alice.submit(id), alice.submit(id), alice.submit(id)])
    for (const res of [a, b, c]) expect(res.status).toBe(200)
    expect(b.body.debrief).toEqual(a.body.debrief)
    expect(c.body.debrief).toEqual(a.body.debrief)

    const later = await alice.submit(id)
    expect(later.body.debrief).toEqual(a.body.debrief)

    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM attempt_results WHERE attempt_id = $1', [id])
    expect(rows[0].n).toBe(1)

    const debrief = a.body.debrief
    expect(debrief.gradingVersionId).toMatch(/^grading-/)
    expect(debrief.contentVersionId).toMatch(/^chest-pressure@[0-9a-f]{12}$/)
    if (debrief.criticalSafetyError) {
      expect(debrief.finalScore).toBeLessThanOrEqual(59)
      expect(debrief.passed).toBe(false)
    }
  })

  it('locks the attempt after submit', async () => {
    const id = await completeAttempt('alice')
    await as('alice').submit(id)
    const late = await as('alice').event(id, { type: 'action', tool: 'record_follow_up', actionIds: ['x'], confirmed: true })
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe('attempt_submitted')
  })

  it('grades against the pinned content version after the scenario changes', async () => {
    const id = await completeAttempt('alice')
    const pinned = (await as('alice').get(id)).body.contentVersionId as string
    // Simulate an edited scenario shipping: the stored definition, not the current file, is graded.
    await db.pool.query(
      `UPDATE content_versions SET definition = jsonb_set(definition, '{correctPrimary}', '"something-else"') WHERE id = $1`,
      [pinned],
    )
    const res = await as('alice').submit(id)
    expect(res.body.debrief.contentVersionId).toBe(pinned)
    expect(res.body.debrief.strengths.join(' ')).not.toContain('Primary diagnosis aligned')
  })
})

describe('refresh, resume and new device', () => {
  it('resumes the same active attempt and its recorded progress', async () => {
    const alice = as('alice')
    const first = await alice.start()
    expect(first.status).toBe(201)
    expect(first.body.resumed).toBe(false)
    const id = first.body.attempt.id
    await alice.event(id, { type: 'action', tool: 'record_history_topics', actionIds: [firstAction('history').id] })
    await alice.event(id, { type: 'lock_phase', phase: 'history' })

    const resumed = await alice.start()
    expect(resumed.status).toBe(200)
    expect(resumed.body.resumed).toBe(true)
    expect(resumed.body.attempt.id).toBe(id)
    expect(resumed.body.attempt.currentPhase).toBe('exam')
    expect(resumed.body.attempt.events.map((e: { actionId: string }) => e.actionId)).toEqual([firstAction('history').id])
  })

  it('only creates one active attempt under concurrent starts', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => as('alice').start()))
    expect(new Set(results.map((r) => r.body.attempt.id)).size).toBe(1)
  })

  it('shows a completed attempt from a fresh app instance (new device) for the same user', async () => {
    const id = await completeAttempt('alice')
    const submitted = (await as('alice').submit(id)).body as PublicAttempt

    const otherDevice = await listenLocal(createApp())
    const detail = await request(otherDevice).get(`/api/attempts/${id}`).set('X-Dev-User', 'alice')
    expect(detail.status).toBe(200)
    expect(detail.body.debrief).toEqual(submitted.debrief)

    const history = await request(otherDevice).get('/api/attempts').set('X-Dev-User', 'alice')
    expect(history.body.items).toHaveLength(1)
    expect(history.body.items[0]).toMatchObject({ id, status: 'submitted', finalScore: submitted.debrief!.finalScore })

    const next = await request(otherDevice).post('/api/attempts').set('X-Dev-User', 'alice').send({ scenarioId: 'chest-pressure' })
    expect(next.status).toBe(201)
    expect(next.body.attempt.id).not.toBe(id)
  })

  it('paginates history newest-first with a stable cursor', async () => {
    const alice = as('alice')
    for (const s of ['respiratory', 'dysuria', 'metabolic', 'asthma', 'chest-pressure']) await alice.start(s)
    const page1 = await alice.history('?limit=2')
    const page2 = await alice.history(`?limit=2&cursor=${page1.body.nextCursor}`)
    const page3 = await alice.history(`?limit=2&cursor=${page2.body.nextCursor}`)
    const ids = [...page1.body.items, ...page2.body.items, ...page3.body.items].map((i: { scenarioId: string }) => i.scenarioId)
    expect(ids).toEqual(['chest-pressure', 'asthma', 'metabolic', 'dysuria', 'respiratory'])
    expect(page3.body.nextCursor).toBeNull()
    expect((await alice.history('?status=submitted')).body.items).toEqual([])
  })
})

describe('hidden content never reaches the browser', () => {
  it('scans every attempt response before and after submit', async () => {
    const alice = as('alice')
    const started = await alice.start()
    const id = started.body.attempt.id
    const responses: unknown[] = [started.body]

    const history = firstAction('history')
    responses.push((await alice.event(id, { type: 'action', tool: 'record_history_topics', actionIds: [history.id] })).body)
    responses.push((await alice.get(id)).body)
    for (const phase of ['history', 'exam', 'diagnostics']) responses.push((await alice.event(id, { type: 'lock_phase', phase })).body)
    responses.push((await alice.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: [scenario.correctPrimary], confirmed: true })).body)
    responses.push((await alice.history()).body)
    responses.push((await request(app).get('/api/scenarios')).body)

    const before = JSON.stringify(responses)
    for (const key of forbiddenKeys) expect(collectKeys(responses).has(key), `pre-submit leaked key "${key}"`).toBe(false)
    for (const secret of hiddenStrings(scenario)) expect(before.includes(secret), `pre-submit leaked "${secret}"`).toBe(false)
    expect(before).not.toContain('debrief":{')

    // Unperformed actions' responses must never appear.
    const unperformed = scenario.phases.flatMap((p) => p.actions).filter((a) => a.id !== history.id).map((a) => a.response)
    for (const text of unperformed) expect(before.includes(text), `unperformed response leaked "${text}"`).toBe(false)

    const submitted = (await alice.submit(id)).body
    const keys = collectKeys(submitted)
    // `unsafe` is allowed post-submit only as the debrief's list of the student's own unsafe choices.
    for (const key of ['correctPrimary', 'criticalRules', 'omissions', 'effects', 'unsafeReason', 'response', 'rule', 'definition', 'weights', 'teachingPoints']) {
      expect(keys.has(key), `post-submit leaked key "${key}"`).toBe(false)
    }
    expect(submitted.scenario.planOptions.every((p: object) => Object.keys(p).sort().join() === 'group,id,label')).toBe(true)
    const after = JSON.stringify(submitted)
    for (const text of unperformed) expect(after.includes(text), `post-submit leaked unperformed "${text}"`).toBe(false)
    // Unselected options' unsafe reasons are rubric content, not feedback.
    for (const option of scenario.planOptions.filter((p) => p.unsafeReason)) {
      expect(after.includes(option.unsafeReason!), `post-submit leaked unchosen "${option.unsafeReason}"`).toBe(false)
    }
  })
})

describe('voice history scaffolding', () => {
  const history = scenario.phases.find((p) => p.id === 'history')!.actions
  const key = history.filter((a) => (a.effects ?? []).reduce((n, e) => n + e.points, 0) > 0 && !a.unsafeReason)

  it('serves hints only in voice history: one key question at a time, in authored order, never a distractor', async () => {
    const client = as('hinter')
    const id = (await client.start()).body.attempt.id as string
    expect((await client.get(id)).body.historyMode).toBe('guided')
    expect((await client.event(id, { type: 'hint' })).body.error.code).toBe('wrong_mode')

    const voice = await client.event(id, { type: 'set_mode', mode: 'voice' })
    expect(voice.body.attempt.historyMode).toBe('voice')
    // Asking the first key question directly means a hint never suggests it.
    await client.event(id, { type: 'action', tool: 'record_history_topics', actionIds: [key[0].id] })
    for (let n = 1; n < key.length; n += 1) {
      const res = await client.event(id, { type: 'hint' })
      expect(res.status).toBe(200)
      const hints = (res.body.attempt as PublicAttempt).hints
      expect(hints.map((h) => h.actionId)).toEqual(key.slice(1, n + 1).map((a) => a.id))
      expect(hints.at(-1)!.text).toBe(key[n].paText)
      // A hint records nothing graded.
      expect((res.body.attempt as PublicAttempt).events.map((e) => e.actionId)).toEqual([key[0].id])
    }
    const done = await client.event(id, { type: 'hint' })
    expect(done.status).toBe(409)
    expect(done.body.error.code).toBe('no_hints_left')
    expect(history.length).toBeGreaterThan(key.length) // the case has distractors, and none were offered

    await client.event(id, { type: 'lock_phase', phase: 'history' })
    expect((await client.event(id, { type: 'hint' })).body.error.code).toBe('wrong_phase')
    expect((await client.event(id, { type: 'set_mode', mode: 'guided' })).body.error.code).toBe('wrong_phase')
  })

  it('reports asked, asked-with-hint and missed in the debrief, with hint count and mode switches, and grades as without hints', async () => {
    const run = async (user: string, withHints: boolean) => {
      const client = as(user)
      const id = (await client.start()).body.attempt.id as string
      await client.event(id, { type: 'set_mode', mode: 'voice' })
      await client.event(id, { type: 'action', tool: 'record_history_topics', actionIds: [key[0].id] })
      if (withHints) {
        await client.event(id, { type: 'hint' })
        await client.event(id, { type: 'hint' })
        await client.event(id, { type: 'set_mode', mode: 'guided' })
      }
      await client.event(id, { type: 'action', tool: 'record_history_topics', actionIds: [key[1].id] })
      for (const phase of ['history', 'exam', 'diagnostics']) await client.event(id, { type: 'lock_phase', phase })
      await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: [scenario.correctPrimary], confirmed: true })
      await client.event(id, { type: 'lock_phase', phase: 'diagnosis' })
      return (await client.submit(id)).body as PublicAttempt
    }
    const hinted = await run('hinted', true)
    const plain = await run('plain', false)
    const r = hinted.debrief!.reasoning
    expect(r.hintsUsed).toBe(2)
    expect(r.modeChanges.map((m) => m.mode)).toEqual(['voice', 'guided'])
    expect(r.historyChecklist.map((c) => [c.actionId, c.status])).toEqual(key.map((a, i) => [a.id, i === 0 ? 'asked' : i === 1 ? 'asked_with_hint' : 'missed']))
    expect(r.historyChecklist[0].offsetMs).not.toBeNull()
    expect(r.historyChecklist.at(-1)!.offsetMs).toBeNull()
    expect(plain.debrief!.reasoning.hintsUsed).toBe(0)
    expect(plain.debrief!.reasoning.historyChecklist[1].status).toBe('asked')
    expect(hinted.debrief!.finalScore).toBe(plain.debrief!.finalScore)
    expect(hinted.debrief!.categoryScores).toEqual(plain.debrief!.categoryScores)
  })
})
