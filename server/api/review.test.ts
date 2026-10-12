import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AttemptRemediation, ReviewSessionResponse, SubmitReviewResponse } from '../../src/api/contracts'
import { deriveMisses } from '../../src/domain/remediation/misses'
import { dayEnd, localDay } from '../../src/domain/review/day'
import type { PhaseId } from '../../src/domain/types'
import { createApp } from '../app'
import { devAuthProvider, setAuthProvider } from '../auth/context'
import { contentPackage } from '../content/scenarios'
import { setClock } from '../lib/clock'
import { createFsrsScheduler, DEFAULT_FSRS_PARAMS, getScheduler, setSchedulerForTests } from '../review/scheduler'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'

type Selections = Record<PhaseId, string[]>

let db: TestDatabase
let app: Server
const TZ = 'America/Denver'
const pkg = contentPackage()
const fixture = (scenarioId: string, kind: string): Selections => structuredClone(pkg.fixtures[scenarioId].fixtures.find((f) => f.kind === kind)!.selections)
let keySeq = 0
const nextKey = () => `review-key-${(keySeq += 1).toString().padStart(5, '0')}`

// 2026-10-10 15:00 MDT: mid-afternoon in Denver, safely inside the study day.
let clock = new Date('2026-10-10T21:00:00Z')
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}
const DAY = 86_400_000

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
  clock = new Date('2026-10-10T21:00:00Z')
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

const as = (user: string, server: Server = app) => {
  const r = () => request(server)
  return {
    start: (scenarioId: string) => r().post('/api/attempts').set('X-Dev-User', user).send({ scenarioId }),
    event: (id: string, body: object) => r().post(`/api/attempts/${id}/events`).set('X-Dev-User', user).set('Idempotency-Key', nextKey()).send(body),
    submit: (id: string) => r().post(`/api/attempts/${id}/submit`).set('X-Dev-User', user),
    remediation: (id: string) => r().get(`/api/attempts/${id}/remediation`).query({ timeZone: TZ }).set('X-Dev-User', user),
    summary: (timeZone = TZ) => r().get('/api/review/summary').query({ timeZone }).set('X-Dev-User', user),
    session: (mode: 'all' | 'micro', extra: object = {}) => r().post('/api/review/sessions').set('X-Dev-User', user).send({ mode, timeZone: TZ, ...extra }),
    current: () => r().get('/api/review/sessions/current').query({ timeZone: TZ }).set('X-Dev-User', user),
    review: (cardId: string, body: object, key = nextKey()) => r().post(`/api/review/cards/${cardId}/reviews`).set('X-Dev-User', user).set('Idempotency-Key', key).send(body),
    reviewEvent: (sessionId: string, body: object) => r().post(`/api/review/sessions/${sessionId}/events`).set('X-Dev-User', user).send(body),
  }
}

const ok = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBe(200)

/** Plays a case through the guided API and submits it. Returns the attempt id. */
async function play(user: string, scenarioId: string, sel: Selections, confidence?: 'sure' | 'unsure', submit = true): Promise<string> {
  const client = as(user)
  const started = await client.start(scenarioId)
  expect(started.status, JSON.stringify(started.body)).toBeLessThan(300)
  const id = started.body.attempt.id as string
  for (const phase of ['history', 'exam', 'diagnostics'] as const) {
    if (sel[phase].length) ok(await client.event(id, { type: 'action', tool: toolFor[phase], actionIds: sel[phase] }))
    ok(await client.event(id, { type: 'lock_phase', phase }))
  }
  const dx = await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: sel.diagnosis, confirmed: true, ...(confidence ? { confidence } : {}) })
  ok(dx)
  ok(await client.event(id, { type: 'lock_phase', phase: 'diagnosis' }))
  const scenario = pkg.scenarios.find((s) => s.id === scenarioId)!
  for (const optionId of sel.treatment) {
    const group = scenario.planOptions.find((p) => p.id === optionId)!.group
    ok(await client.event(id, { type: 'action', tool: planToolFor[group], actionIds: [optionId], confirmed: true }))
  }
  if (submit) ok(await client.submit(id))
  return id
}

const count = async (sql: string, params: unknown[] = []) => Number((await db.pool.query(sql, params)).rows[0].n)

describe('a missed objective becomes due', () => {
  it('turns a skipped red-flag screen into a review card due today, with a traceable reason', async () => {
    const sel = fixture('respiratory', 'happy-path')
    sel.history = sel.history.filter((id) => id !== 'redflags')
    const attemptId = await play('alice', 'respiratory', sel, 'sure')

    const rem = (await as('alice').remediation(attemptId)).body as AttemptRemediation
    expect(rem.authored).toBe(true)
    expect(rem.draftContent).toBe(true)
    expect(rem.items).toEqual([
      expect.objectContaining({ rubricItemId: 'omit-redflags', kind: 'omission', errorType: 'data-gathering-omission', status: 'linked', cards: [expect.objectContaining({ dueToday: true })] }),
    ])

    const res = (await as('alice').session('all')).body as ReviewSessionResponse
    expect(res.dueToday).toBe(1)
    const item = res.session!.items[0]
    expect(item).toMatchObject({ status: 'current', knowledgeLabel: 'Red-flag screen in sore throat and cough', reason: { code: 'new-miss' } })
    expect(item.reason.text).toContain('Cough and sore throat')
    expect(item.source).toEqual({ attemptId, scenarioTitle: 'Cough and sore throat', rubricItemId: 'omit-redflags', label: expect.any(String) })
    expect(item.prompt.id).toMatch(/^red-flag-/)
  })

  it('creates nothing to review for a clean, confident attempt', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'happy-path'), 'sure')
    expect((await as('alice').summary()).body).toMatchObject({ dueToday: 0, totalCards: 0 })
    expect((await as('alice').session('all')).body).toEqual({ session: null, resumed: false, dueToday: 0 })
  })
})

describe('a successful review changes the schedule', () => {
  it('moves the card past today and out of the queue, then brings it back when due', async () => {
    const sel = fixture('respiratory', 'happy-path')
    sel.history = sel.history.filter((id) => id !== 'redflags')
    await play('alice', 'respiratory', sel, 'sure')
    const session = (await as('alice').session('all')).body.session
    const item = session.items[0]

    const res = await as('alice').review(item.cardId, { sessionId: session.id, promptId: item.prompt.id, rating: 3, latencyMs: 4200 })
    expect(res.status).toBe(200)
    const body = res.body as SubmitReviewResponse
    expect(body.nextDueInDays).toBeGreaterThanOrEqual(1)
    expect(Date.parse(body.nextDue)).toBeGreaterThanOrEqual(dayEnd(localDay(clock, TZ), TZ).getTime())
    expect(body.session).toMatchObject({ position: 1, total: 1, done: true })
    expect((await as('alice').summary()).body.dueToday).toBe(0)

    const card = (await db.pool.query('SELECT reps, fsrs_state, due_reason FROM review_cards WHERE id = $1', [item.cardId])).rows[0]
    expect(card).toMatchObject({ reps: 1, fsrs_state: 2, due_reason: { code: 'scheduled' } })

    clock = new Date(Date.parse(body.nextDue) + 60_000)
    const later = (await as('alice').session('all')).body as ReviewSessionResponse
    expect(later.session!.items[0]).toMatchObject({ cardId: item.cardId, reason: { code: 'scheduled' } })
    expect(later.session!.items[0].reason.text).toMatch(/last reviewed this on Oct 10/)
  })

  it('"Missed it" keeps the card sooner than "Got it" would', async () => {
    const run = async (user: string, rating: number) => {
      const sel = fixture('respiratory', 'happy-path')
      sel.history = sel.history.filter((id) => id !== 'redflags')
      await play(user, 'respiratory', sel)
      const s = (await as(user).session('all')).body.session
      return (await as(user).review(s.items[0].cardId, { sessionId: s.id, promptId: s.items[0].prompt.id, rating })).body as SubmitReviewResponse
    }
    const missed = await run('miss', 1)
    const got = await run('got', 3)
    expect(Date.parse(missed.nextDue)).toBeLessThan(Date.parse(got.nextDue))
  })
})

describe('duplicate events', () => {
  it('replays a repeated idempotency key without a second review, and rejects a changed body', async () => {
    const sel = fixture('respiratory', 'partial-credit')
    await play('alice', 'respiratory', sel, 'sure')
    const s = (await as('alice').session('all')).body.session
    const item = s.items[0]
    const body = { sessionId: s.id, promptId: item.prompt.id, rating: 3, latencyMs: 1000 }

    const first = await as('alice').review(item.cardId, body, 'same-key-0001')
    const again = await as('alice').review(item.cardId, body, 'same-key-0001')
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await count('SELECT count(*) AS n FROM review_events')).toBe(1)
    expect(await count(`SELECT count(*) AS n FROM learning_events WHERE type = 'rated'`)).toBe(1)

    const changed = await as('alice').review(item.cardId, { ...body, rating: 1 }, 'same-key-0001')
    expect(changed.status).toBe(409)
    expect(changed.body.error.code).toBe('idempotency_conflict')
  })

  it('rejects rating an item out of order, so a stale tab cannot skip ahead', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'partial-credit'), 'sure')
    const s = (await as('alice').session('all')).body.session
    expect(s.items.length).toBeGreaterThan(1)
    const res = await as('alice').review(s.items[1].cardId, { sessionId: s.id, promptId: s.items[1].prompt.id, rating: 3 })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('review_out_of_order')
  })

  it('counts shown and answered once per item per session', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'partial-credit'))
    const s = (await as('alice').session('all')).body.session
    for (let i = 0; i < 3; i += 1) {
      expect((await as('alice').reviewEvent(s.id, { type: 'shown', cardId: s.items[0].cardId })).status).toBe(200)
      expect((await as('alice').reviewEvent(s.id, { type: 'answered', cardId: s.items[0].cardId, latencyMs: 3000 })).status).toBe(200)
    }
    expect(await count(`SELECT count(*) AS n FROM learning_events WHERE type IN ('shown', 'answered')`)).toBe(2)
  })
})

describe('no duplicate cards for the same knowledge component', () => {
  it('adds evidence to the existing card and brings it forward when the miss repeats', async () => {
    const sel = fixture('respiratory', 'happy-path')
    sel.history = sel.history.filter((id) => id !== 'redflags')
    await play('alice', 'respiratory', sel)
    const s = (await as('alice').session('all')).body.session
    await as('alice').review(s.items[0].cardId, { sessionId: s.id, promptId: s.items[0].prompt.id, rating: 3 })

    advance(DAY)
    const second = await play('alice', 'respiratory', sel)
    expect(await count(`SELECT count(*) AS n FROM review_cards WHERE kc_id = 'sore-throat-red-flag-screen'`)).toBe(1)
    expect(await count(`SELECT count(*) AS n FROM evidence_cards`)).toBe(2)
    const card = (await db.pool.query('SELECT due, due_reason, reps FROM review_cards')).rows[0]
    expect(card.reps).toBe(1)
    expect(card.due_reason).toMatchObject({ code: 'new-evidence', attemptId: second })
    expect(card.due.getTime()).toBe(clock.getTime())
    const next = (await as('alice').session('all')).body.session
    expect(next.items[0].reason.text).toMatch(/^Missed again/)
    expect(next.items[0].source.attemptId).toBe(second)
  })

  it('merges two misses of the same component in one attempt into one card', async () => {
    const sel = fixture('respiratory', 'happy-path')
    sel.diagnostics = ['flu', 'cbc']
    await play('alice', 'respiratory', sel, 'sure')
    expect(await count(`SELECT count(*) AS n FROM review_cards WHERE kc_id = 'low-value-testing-viral-uri'`)).toBe(1)
    const card = (await db.pool.query(`SELECT due_reason FROM review_cards WHERE kc_id = 'low-value-testing-viral-uri'`)).rows[0]
    expect(card.due_reason.code).toBe('new-miss')
  })
})

describe('progress survives refresh', () => {
  it('resumes the same frozen queue and position from a fresh server instance', async () => {
    await play('alice', 'respiratory', {
      history: ['duration', 'antibiotic'],
      exam: ['vitals', 'imaging'],
      diagnostics: ['flu', 'cbc'],
      diagnosis: ['pneumonia'],
      treatment: ['antibiotics', 'ed'],
    })
    const started = (await as('alice').session('micro')).body as ReviewSessionResponse
    const s = started.session!
    expect(s.total).toBe(5)
    expect(started.dueToday).toBeGreaterThan(5)
    for (const item of s.items.slice(0, 2)) {
      expect((await as('alice').review(item.cardId, { sessionId: s.id, promptId: item.prompt.id, rating: 3 })).status).toBe(200)
    }

    const otherDevice = await listenLocal(createApp())
    const resumed = (await as('alice', otherDevice).current()).body as ReviewSessionResponse
    expect(resumed.resumed).toBe(true)
    expect(resumed.session).toMatchObject({ id: s.id, position: 2, total: 5, done: false })
    expect(resumed.session!.items.map((i) => [i.cardId, i.prompt.id])).toEqual(s.items.map((i) => [i.cardId, i.prompt.id]))
    expect(resumed.session!.items.map((i) => i.status)).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming'])

    // Starting again on the same day resumes rather than rebuilding the queue.
    const again = (await as('alice').session('micro')).body as ReviewSessionResponse
    expect(again).toMatchObject({ resumed: true, session: { id: s.id, position: 2 } })
  })

  it('expires an unfinished session at the 04:00 local rollover', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'partial-credit'))
    const s = (await as('alice').session('all')).body.session
    clock = new Date('2026-10-11T09:59:00Z') // 03:59 MDT: still Oct 10's study day
    expect((await as('alice').current()).body.session.id).toBe(s.id)
    clock = new Date('2026-10-11T10:00:00Z') // 04:00 MDT
    expect((await as('alice').current()).body.session).toBeNull()
    const fresh = (await as('alice').session('all')).body.session
    expect(fresh.id).not.toBe(s.id)
    expect(fresh.localDay).toBe('2026-10-11')
  })
})

describe('leakage', () => {
  it('refuses the review plan before submission and hides it from other users', async () => {
    const id = await play('alice', 'respiratory', fixture('respiratory', 'partial-credit'), undefined, false)
    const early = await as('alice').remediation(id)
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe('attempt_not_submitted')
    expect((await as('alice').summary()).body.totalCards).toBe(0)

    await as('alice').submit(id)
    expect((await as('alice').remediation(id)).status).toBe(200)
    const other = await as('mallory').remediation(id)
    expect(other.status).toBe(404)
    expect((await as('mallory').session('all')).body.session).toBeNull()
  })

  it('never serves prompts from a case the user has not submitted', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'partial-credit'))
    const s = (await as('alice').session('all')).body.session
    const respiratoryPrompts = new Set(pkg.remediation.respiratory.prompts.map((p) => p.id))
    for (const item of s.items) expect(respiratoryPrompts.has(item.prompt.id)).toBe(true)
  })

  it('does not let another user rate or log against your cards', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'partial-credit'))
    const s = (await as('alice').session('all')).body.session
    const res = await as('mallory').review(s.items[0].cardId, { sessionId: s.id, promptId: s.items[0].prompt.id, rating: 3 })
    expect(res.status).toBe(404)
    expect((await as('mallory').reviewEvent(s.id, { type: 'shown', cardId: s.items[0].cardId })).status).toBe(404)
  })
})

describe('cases without authored remediation', () => {
  it('records every miss as unmapped and creates no cards', async () => {
    const sel = fixture('dysuria', 'partial-credit')
    const id = await play('alice', 'dysuria', sel)
    const rem = (await as('alice').remediation(id)).body as AttemptRemediation
    expect(rem.authored).toBe(false)
    expect(rem.items.length).toBe(deriveMisses(pkg.scenarios.find((s) => s.id === 'dysuria')!, sel).length)
    expect(rem.items.length).toBeGreaterThan(0)
    for (const item of rem.items) expect(item).toMatchObject({ status: 'unmapped', cards: [] })
    expect(await count('SELECT count(*) AS n FROM review_cards')).toBe(0)
  })
})

describe('guessed-correct', () => {
  it('turns a correct but unsure diagnosis into review of the differential', async () => {
    const id = await play('alice', 'respiratory', fixture('respiratory', 'happy-path'), 'unsure')
    const rem = (await as('alice').remediation(id)).body as AttemptRemediation
    expect(rem.items).toEqual([expect.objectContaining({ rubricItemId: 'guessed-correct', kind: 'guessed-correct', errorType: 'guessed-correct', status: 'linked' })])
    expect(rem.items[0].cards.map((c) => c.knowledgeLabel).sort()).toEqual(['Pneumonia versus uncomplicated viral illness', 'Streptococcal versus viral pharyngitis'])
  })

  it('keeps the latest confidence when the same diagnosis is re-confirmed, and stores it server-side only', async () => {
    const client = as('alice')
    const id = (await client.start('respiratory')).body.attempt.id as string
    for (const phase of ['history', 'exam', 'diagnostics']) await client.event(id, { type: 'lock_phase', phase })
    await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: ['viral-uri'], confirmed: true, confidence: 'unsure' })
    const again = await client.event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: ['viral-uri'], confirmed: true, confidence: 'sure' })
    expect(again.body.result.duplicates).toEqual(['viral-uri'])
    const rows = (await db.pool.query(`SELECT detail FROM attempt_events WHERE attempt_id = $1 AND phase = 'diagnosis' AND retracted_at IS NULL`, [id])).rows
    expect(rows).toEqual([{ detail: { confidence: 'sure', confidenceHistory: [{ confidence: 'unsure', at: clock.toISOString() }, { confidence: 'sure', at: clock.toISOString() }] } }])
    expect(JSON.stringify(again.body)).not.toContain('confidence')
  })

  it('rejects confidence on anything but the primary diagnosis', async () => {
    const started = await as('alice').start('respiratory')
    const res = await as('alice').event(started.body.attempt.id, { type: 'action', tool: 'record_history_topics', actionIds: ['fever'], confidence: 'sure' })
    expect(res.status).toBe(400)
  })
})

describe('lazy backfill and algorithm upgrades', () => {
  it('derives an attempt submitted before remediation existed on the next review request', async () => {
    const sel = fixture('respiratory', 'partial-credit')
    const id = await play('alice', 'respiratory', sel)
    await db.pool.query('DELETE FROM review_cards')
    await db.pool.query('DELETE FROM remediation_evidence')
    await db.pool.query('DELETE FROM remediation_derivations')
    expect((await as('alice').summary()).body.totalCards).toBeGreaterThan(0)
    expect(await count('SELECT count(*) AS n FROM remediation_evidence WHERE attempt_id = $1', [id])).toBe(deriveMisses(pkg.scenarios.find((s) => s.id === 'respiratory')!, sel).length)
  })

  it('replays cards under a new algorithm version and stamps them', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'partial-credit'))
    const s = (await as('alice').session('all')).body.session
    await as('alice').review(s.items[0].cardId, { sessionId: s.id, promptId: s.items[0].prompt.id, rating: 3 })
    const before = (await db.pool.query('SELECT due, params_id FROM review_cards WHERE id = $1', [s.items[0].cardId])).rows[0]

    // A stand-in for a new algorithm version: lower requested retention lengthens intervals.
    const upgraded = createFsrsScheduler({ ...DEFAULT_FSRS_PARAMS, request_retention: 0.8 })
    expect(before.params_id).toBe(getScheduler().paramsId)
    setSchedulerForTests(upgraded)
    await as('alice').summary()
    const after = (await db.pool.query('SELECT due, params_id FROM review_cards WHERE id = $1', [s.items[0].cardId])).rows[0]
    expect(after.params_id).toBe(upgraded.paramsId)
    expect(after.due.getTime()).toBeGreaterThan(before.due.getTime())
    expect(await count(`SELECT count(*) AS n FROM review_cards WHERE params_id <> $1`, [upgraded.paramsId])).toBe(0)
  })
})

describe('time zones', () => {
  it('rejects an unknown zone', async () => {
    const res = await as('alice').summary('Mars/Olympus_Mons')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_time_zone')
  })

  it('stores the browser zone with the user', async () => {
    await play('alice', 'respiratory', fixture('respiratory', 'partial-credit'))
    await as('alice').session('all')
    expect((await db.pool.query(`SELECT time_zone FROM users WHERE external_subject = 'alice'`)).rows[0].time_zone).toBe(TZ)
  })
})

describe('acceptance: every graded miss has a traceable remediation state', () => {
  it('derives an evidence row for every miss of every fixture of every case', { timeout: 120_000 }, async () => {
    let n = 0
    for (const s of pkg.scenarios) {
      for (const f of pkg.fixtures[s.id].fixtures) {
        for (const confidence of ['sure', 'unsure'] as const) {
          const user = `acc-${(n += 1)}`
          const id = await play(user, s.id, structuredClone(f.selections), confidence)
          const expected = deriveMisses(s, f.selections, confidence)
          const rem = (await as(user).remediation(id)).body as AttemptRemediation
          expect(rem.items.map((i) => i.rubricItemId).sort(), `${s.id}/${f.id}/${confidence}`).toEqual(expected.map((m) => m.rubricItemId).sort())
          for (const item of rem.items) {
            if (pkg.remediation[s.id]) expect(item.status, `${s.id}/${item.rubricItemId}`).toBe('linked')
            else expect(item.status).toBe('unmapped')
          }
        }
      }
    }
  })
})
