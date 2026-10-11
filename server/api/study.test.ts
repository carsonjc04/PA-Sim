import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PublicBlueprintSummary, PublicCoverage, PublicScenario, PublicSprint, PublicStudyPlan, PublicTaxonomy } from '../../src/api/contracts'
import type { PhaseId } from '../../src/domain/types'
import { createApp } from '../app'
import { devAuthProvider, setAuthProvider } from '../auth/context'
import { contentPackage } from '../content/scenarios'
import { setClock } from '../lib/clock'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'

type Selections = Record<PhaseId, string[]>

let db: TestDatabase
let app: Server
const TZ = 'America/Denver'
const pkg = contentPackage()
const fixture = (scenarioId: string, kind: string): Selections => structuredClone(pkg.fixtures[scenarioId].fixtures.find((f) => f.kind === kind)!.selections)
let keySeq = 0
const nextKey = () => `study-key-${(keySeq += 1).toString().padStart(5, '0')}`
const DX = 'formulating-the-most-likely-diagnosis'

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
  setClock(() => new Date('2026-10-11T18:00:00Z'))
})
afterEach(() => setClock(null))

const get = (path: string, user?: string) => {
  const r = request(app).get(path)
  return user ? r.set('X-Dev-User', user) : r
}
const ok = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBe(200)

const toolFor: Record<string, string> = { history: 'record_history_topics', exam: 'request_physical_exam', diagnostics: 'order_diagnostic_test' }
const planToolFor: Record<string, string> = { treatment: 'propose_treatment_plan', counseling: 'propose_treatment_plan', disposition: 'record_disposition', 'follow-up': 'record_follow_up', return: 'record_follow_up' }

/** Plays a case through the guided API and submits it. */
async function play(user: string, scenarioId: string, sel: Selections): Promise<string> {
  const post = (path: string, body: object) => request(app).post(path).set('X-Dev-User', user).set('Idempotency-Key', nextKey()).send(body)
  const started = await request(app).post('/api/attempts').set('X-Dev-User', user).send({ scenarioId })
  expect(started.status, JSON.stringify(started.body)).toBeLessThan(300)
  const id = started.body.attempt.id as string
  for (const phase of ['history', 'exam', 'diagnostics'] as const) {
    if (sel[phase].length) ok(await post(`/api/attempts/${id}/events`, { type: 'action', tool: toolFor[phase], actionIds: sel[phase] }))
    ok(await post(`/api/attempts/${id}/events`, { type: 'lock_phase', phase }))
  }
  ok(await post(`/api/attempts/${id}/events`, { type: 'action', tool: 'propose_diagnosis', actionIds: sel.diagnosis, confirmed: true }))
  ok(await post(`/api/attempts/${id}/events`, { type: 'lock_phase', phase: 'diagnosis' }))
  const scenario = pkg.scenarios.find((s) => s.id === scenarioId)!
  for (const optionId of sel.treatment) {
    const group = scenario.planOptions.find((p) => p.id === optionId)!.group
    ok(await post(`/api/attempts/${id}/events`, { type: 'action', tool: planToolFor[group], actionIds: [optionId], confirmed: true }))
  }
  ok(await request(app).post(`/api/attempts/${id}/submit`).set('X-Dev-User', user))
  return id
}

describe('public study data', () => {
  it('offers only active vocabulary terms for filters, including all seven rotations', async () => {
    const res = await get('/api/study/taxonomy')
    ok(res)
    const t = res.body as PublicTaxonomy
    expect(t.panceTasks.map((x) => x.id)).not.toContain('patient-education')
    expect(t.panceTasks).toHaveLength(8)
    expect(t.organSystems).toHaveLength(15)
    expect(t.eorRotations.map((r) => r.id).sort()).toEqual(['emergency-medicine', 'family-medicine', 'internal-medicine', 'pediatrics', 'psychiatry-behavioral-health', 'surgery', 'women-s-health'])
  })

  it('lists blueprints with source metadata and a lifecycle derived from the day', async () => {
    const res = await get('/api/study/blueprints')
    ok(res)
    const list = res.body as PublicBlueprintSummary[]
    expect(list).toHaveLength(14)
    expect(list.find((b) => b.id === 'paea-eor-family-medicine-2018')).toMatchObject({ lifecycle: 'legacy', effectiveUntil: '2027-07-31', transcriptionVerified: false })
    expect(list.find((b) => b.id === 'nccpa-pance-2025')?.source.retrievedVia).toMatch(/web\.archive\.org/)

    setClock(() => new Date('2027-08-02T18:00:00Z'))
    const later = (await get('/api/study/blueprints')).body as PublicBlueprintSummary[]
    expect(later.find((b) => b.id === 'paea-eor-family-medicine-2018')?.lifecycle).toBe('retired')
  })

  it('reports honest coverage with no exam simulation, no alignment claim and no hidden case data', async () => {
    const res = await get('/api/study/blueprints/nccpa-pance-2025/coverage')
    ok(res)
    const body = res.body as PublicCoverage
    expect(body.fullExam.available).toBe(false)
    expect(body.alignment).toMatchObject({ claimed: false, reviewedItems: 0 })
    expect(body.coverage.summary.contentCategoriesWithItems).toBeLessThan(body.coverage.summary.contentCategories)
    const text = JSON.stringify(body).toLowerCase()
    for (const leak of ['acute coronary syndrome', 'correctprimary', 'spoilerterms', 'rubric', 'cystitis', 'teachingpoints']) expect(text).not.toContain(leak)
    expect(Object.keys(body.items[0]).sort()).toEqual(['id', 'title'])
  })

  it('returns 404 for an unknown blueprint', async () => {
    expect((await get('/api/study/blueprints/nccpa-pance-1999/coverage')).status).toBe(404)
  })

  it('adds canonical filter tags to public scenarios without topic tags or review data', async () => {
    const list = (await get('/api/scenarios')).body as PublicScenario[]
    const metabolic = list.find((s) => s.id === 'metabolic')!
    expect(metabolic.tags.panceTasks).toContain('health-maintenance-education-prevention')
    expect(Object.keys(metabolic.tags).sort()).toEqual(['eorRotations', 'organSystems', 'panceTasks', 'suitability'])
  })
})

describe('study plans', () => {
  const plan = (user: string | undefined, query: Record<string, string>) => {
    const r = request(app).get('/api/study/plan').query({ timeZone: TZ, ...query })
    return user ? r.set('X-Dev-User', user) : r
  }

  it('requires a user', async () => {
    expect((await plan(undefined, { mode: 'mixed', blueprint: 'nccpa-pance-2025' })).status).toBe(401)
  })

  it('rejects a mode that does not fit the blueprint, and a retired version', async () => {
    expect((await plan('alice', { mode: 'rotation', blueprint: 'nccpa-pance-2025' })).status).toBe(400)
    expect((await plan('alice', { mode: 'pance', blueprint: 'paea-eor-surgery-2023' })).status).toBe(400)
    setClock(() => new Date('2027-08-02T18:00:00Z'))
    expect((await plan('alice', { mode: 'rotation', blueprint: 'paea-eor-surgery-2023' })).status).toBe(200)
    expect((await plan('alice', { mode: 'rotation', blueprint: 'paea-eor-family-medicine-2018' })).status).toBe(410)
  })

  it('starts with no data and ranks by blueprint weight', async () => {
    const res = await plan('alice', { mode: 'mixed', blueprint: 'nccpa-pance-2025' })
    ok(res)
    const body = res.body as PublicStudyPlan
    expect(body.basis.submittedAttempts).toBe(0)
    expect(body.pairs.every((p) => p.noData)).toBe(true)
    expect(body.basis.method).toMatch(/not a validated prediction/)
  })

  it('raises weakness for a missed diagnosis, from the learner’s own submitted attempt only', async () => {
    await play('alice', 'chest-pressure', fixture('chest-pressure', 'wrong-path'))
    const mine = (await plan('alice', { mode: 'mixed', blueprint: 'nccpa-pance-2025' })).body as PublicStudyPlan
    const cvDx = mine.pairs.find((p) => p.content === 'cardiovascular-system' && p.task === DX)!
    expect(cvDx).toMatchObject({ attempts: 1, misses: 1, noData: false })
    const theirs = (await plan('bob', { mode: 'mixed', blueprint: 'nccpa-pance-2025' })).body as PublicStudyPlan
    expect(theirs.pairs.every((p) => p.noData)).toBe(true)
  })

  it('counts an attempt under the tags of the case version it was played on, not a later re-tag', async () => {
    const attemptId = await play('alice', 'metabolic', fixture('metabolic', 'wrong-path'))
    // Simulate the stored snapshot having been tagged differently (as an older version would have been).
    await db.pool.query(
      `UPDATE content_versions SET definition = jsonb_set(definition, '{taxonomy,organSystems}', '["renal-system"]')
       WHERE id = (SELECT content_version_id FROM attempts WHERE id = $1)`,
      [attemptId],
    )
    const body = (await plan('alice', { mode: 'mixed', blueprint: 'nccpa-pance-2025' })).body as PublicStudyPlan
    expect(body.pairs.find((p) => p.content === 'renal-system' && p.task === DX)).toMatchObject({ attempts: 1, misses: 1 })
    expect(body.pairs.find((p) => p.content === 'endocrine-system' && p.task === DX)).toMatchObject({ attempts: 0, noData: true })
  })

  it('shows rotation-scoped due remediation', async () => {
    const sel = fixture('respiratory', 'happy-path')
    sel.history = sel.history.filter((id) => id !== 'redflags')
    await play('alice', 'respiratory', sel)
    const fm = (await plan('alice', { mode: 'rotation', blueprint: 'paea-eor-family-medicine-2026' })).body as PublicStudyPlan
    expect(fm.dueRemediation.map((d) => d.label)).toContain('Red-flag screen in sore throat and cough')
    const psych = (await plan('alice', { mode: 'rotation', blueprint: 'paea-eor-psychiatry-behavioral-health-2026' })).body as PublicStudyPlan
    expect(psych.dueRemediation).toEqual([])
  })
})

describe('differential sprints', () => {
  const sprints = async (user: string) => (await get('/api/study/sprints', user)).body as PublicSprint[]
  const answer = (user: string, id: string, optionId: string) => request(app).post(`/api/study/sprints/${id}/answer`).set('X-Dev-User', user).send({ optionId })

  it('stays locked, with no findings or options, until the source case is submitted', async () => {
    const list = await sprints('alice')
    expect(list.map((s) => s.id).sort()).toEqual(['acute-dyspnea-wheeze-differential', 'chest-pressure-differential', 'cough-sore-throat-differential'])
    for (const s of list) expect(s).toMatchObject({ locked: true, stem: null, findings: [], options: [], draft: true })
    const res = await answer('alice', 'chest-pressure-differential', 'acs')
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('sprint_locked')
  })

  it('opens after the case, shows the case’s own findings and alphabetised options, and scores on the server', async () => {
    await play('alice', 'chest-pressure', fixture('chest-pressure', 'happy-path'))
    const sprint = (await sprints('alice')).find((s) => s.id === 'chest-pressure-differential')!
    expect(sprint.locked).toBe(false)
    const scenario = pkg.scenarios.find((s) => s.id === 'chest-pressure')!
    const responses = scenario.phases.flatMap((p) => p.actions.map((a) => a.response))
    for (const f of sprint.findings) expect(responses).toContain(f.text)
    expect(sprint.options.map((o) => o.label)).toEqual([...sprint.options.map((o) => o.label)].sort((a, b) => a.localeCompare(b)))
    expect(JSON.stringify(sprint)).not.toMatch(/"answer"|"correct"/)

    const wrong = await answer('alice', 'chest-pressure-differential', 'gerd')
    ok(wrong)
    expect(wrong.body).toMatchObject({ correct: false, chosen: { id: 'gerd' }, answer: { id: 'acs' } })
    const right = await answer('alice', 'chest-pressure-differential', 'acs')
    expect(right.body.correct).toBe(true)
    expect((await answer('alice', 'chest-pressure-differential', 'pe')).status).toBe(400)
    expect((await answer('alice', 'no-such-sprint', 'acs')).status).toBe(404)
  })

  it('requires a user', async () => {
    expect((await get('/api/study/sprints')).status).toBe(401)
  })
})
