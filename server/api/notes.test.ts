import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicAnnotation, PublicNotes } from '../../src/api/contracts'
import type { PhaseId } from '../../src/domain/types'
import { createApp } from '../app'
import { devAuthProvider, setAuthProvider } from '../auth/context'
import { contentPackage } from '../content/scenarios'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'

let db: TestDatabase
let app: Server
const pkg = contentPackage()
let keySeq = 0
const key = () => `notes-key-${(keySeq += 1).toString().padStart(5, '0')}`
// A distinctive string so leakage scans cannot match anything else.
const SECRET = 'zebra-quartz-7731 differential thinking'

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
afterEach(() => vi.restoreAllMocks())

const as = (user: string) => ({
  start: (scenarioId = 'respiratory') => request(app).post('/api/attempts').set('X-Dev-User', user).send({ scenarioId }),
  notes: (id: string) => request(app).get(`/api/attempts/${id}/notes`).set('X-Dev-User', user),
  save: (id: string, body: string, version: number) => request(app).put(`/api/attempts/${id}/notes`).set('X-Dev-User', user).send({ body, version }),
  annotations: (id: string) => request(app).get(`/api/attempts/${id}/annotations`).set('X-Dev-User', user),
  annotate: (id: string, targetKind: string, targetId: string, marks: string[]) =>
    request(app).put(`/api/attempts/${id}/annotations`).set('X-Dev-User', user).send({ targetKind, targetId, marks }),
  attempt: (id: string) => request(app).get(`/api/attempts/${id}`).set('X-Dev-User', user),
  history: () => request(app).get('/api/attempts').set('X-Dev-User', user),
  event: (id: string, body: object) => request(app).post(`/api/attempts/${id}/events`).set('X-Dev-User', user).set('Idempotency-Key', key()).send(body),
  submit: (id: string) => request(app).post(`/api/attempts/${id}/submit`).set('X-Dev-User', user),
})

async function startedAttempt(user = 'alice'): Promise<string> {
  const res = await as(user).start()
  expect(res.status).toBeLessThan(300)
  return res.body.attempt.id as string
}

async function submitHappyPath(user: string, id: string) {
  const sel = pkg.fixtures.respiratory.fixtures.find((f) => f.kind === 'happy-path')!.selections as Record<PhaseId, string[]>
  const tools = { history: 'record_history_topics', exam: 'request_physical_exam', diagnostics: 'order_diagnostic_test' } as const
  for (const phase of ['history', 'exam', 'diagnostics'] as const) {
    if (sel[phase].length) expect((await as(user).event(id, { type: 'action', tool: tools[phase], actionIds: sel[phase] })).status).toBe(200)
    expect((await as(user).event(id, { type: 'lock_phase', phase })).status).toBe(200)
  }
  expect((await as(user).event(id, { type: 'action', tool: 'propose_diagnosis', actionIds: sel.diagnosis, confirmed: true })).status).toBe(200)
  expect((await as(user).event(id, { type: 'lock_phase', phase: 'diagnosis' })).status).toBe(200)
  const scenario = pkg.scenarios.find((s) => s.id === 'respiratory')!
  const planTool = { treatment: 'propose_treatment_plan', counseling: 'propose_treatment_plan', disposition: 'record_disposition', 'follow-up': 'record_follow_up', return: 'record_follow_up' } as const
  for (const o of sel.treatment) {
    const group = scenario.planOptions.find((p) => p.id === o)!.group
    expect((await as(user).event(id, { type: 'action', tool: planTool[group], actionIds: [o], confirmed: true })).status).toBe(200)
  }
  expect((await as(user).submit(id)).status).toBe(200)
}

describe('learner notes', () => {
  it('starts empty, then saves with optimistic versioning', async () => {
    const id = await startedAttempt()
    expect((await as('alice').notes(id)).body).toEqual({ body: '', version: 0, updatedAt: null })
    const first = await as('alice').save(id, 'Consider strep vs viral.', 0)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ body: 'Consider strep vs viral.', version: 1 })
    const second = await as('alice').save(id, 'Consider strep vs viral. Centor low.', 1)
    expect((second.body as PublicNotes).version).toBe(2)
    // Saving identical text does not bump the version.
    expect(((await as('alice').save(id, 'Consider strep vs viral. Centor low.', 2)).body as PublicNotes).version).toBe(2)
  })

  it('reports a stale save as a conflict with the saved copy, never overwriting it', async () => {
    const id = await startedAttempt()
    await as('alice').save(id, 'From the laptop', 0)
    const stale = await as('alice').save(id, 'From the phone', 0)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('notes_conflict')
    expect(stale.body.current).toMatchObject({ body: 'From the laptop', version: 1 })
    expect((await as('alice').notes(id)).body.body).toBe('From the laptop')
  })

  it('enforces the length limit', async () => {
    const id = await startedAttempt()
    expect((await as('alice').save(id, 'x'.repeat(4001), 0)).status).toBe(400)
    expect((await as('alice').save(id, 'x'.repeat(4000), 0)).status).toBe(200)
  })

  it('keeps notes private to the attempt owner', async () => {
    const id = await startedAttempt('alice')
    await as('alice').save(id, SECRET, 0)
    expect((await as('bob').notes(id)).status).toBe(404)
    expect((await as('bob').save(id, 'hijack', 1)).status).toBe(404)
    expect((await request(app).get(`/api/attempts/${id}/notes`)).status).toBe(401)
    expect((await as('alice').notes('not-a-uuid')).status).toBe(404)
  })

  it('can still be edited after submission, for later review', async () => {
    const id = await startedAttempt()
    await submitHappyPath('alice', id)
    expect((await as('alice').save(id, 'Retrieve: red flags in sore throat', 0)).status).toBe(200)
  })
})

describe('structural exclusion of notes', () => {
  it('never appears in attempt, history or debrief payloads, or in any other table', async () => {
    const id = await startedAttempt()
    await as('alice').save(id, SECRET, 0)
    await submitHappyPath('alice', id)
    const payloads = [await as('alice').attempt(id), await as('alice').history(), await request(app).get(`/api/attempts/${id}/remediation?timeZone=UTC`).set('X-Dev-User', 'alice')]
    for (const p of payloads) {
      expect(p.status).toBe(200)
      expect(JSON.stringify(p.body)).not.toContain('zebra-quartz')
      expect(JSON.stringify(p.body)).not.toMatch(/"notes"/)
    }
    // Only attempt_notes may hold the text.
    const { rows: tables } = await db.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'attempt_notes'",
    )
    for (const t of tables) {
      const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM ${t.table_name} WHERE ${t.table_name}::text LIKE '%zebra-quartz%'`)
      expect(rows[0].n, t.table_name).toBe(0)
    }
  })

  it('never writes note text to the server log', async () => {
    const lines: string[] = []
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.map(String).join(' ')))
    const id = await startedAttempt()
    await as('alice').save(id, SECRET, 0)
    await as('alice').save(id, `${SECRET} again`, 0) // conflict path
    await as('alice').save(id, 'x'.repeat(5000), 1) // validation path
    expect(lines.join('\n')).not.toContain('zebra-quartz')
  })

  it('is deleted with its attempt', async () => {
    const id = await startedAttempt()
    await as('alice').save(id, SECRET, 0)
    expect((await as('alice').annotate(id, 'action', 'redflags', ['key'])).status).toBe(200)
    expect((await db.pool.query('SELECT count(*)::int AS n FROM attempt_annotations')).rows[0].n).toBe(1)
    await db.pool.query('DELETE FROM attempts WHERE id = $1', [id])
    expect((await db.pool.query('SELECT count(*)::int AS n FROM attempt_notes')).rows[0].n).toBe(0)
    expect((await db.pool.query('SELECT count(*)::int AS n FROM attempt_annotations')).rows[0].n).toBe(0)
  })
})

describe('annotations', () => {
  it('sets, replaces and clears marks on case items', async () => {
    const id = await startedAttempt()
    let res = await as('alice').annotate(id, 'diagnosis', 'pneumonia', ['ruled_out'])
    expect(res.status).toBe(200)
    await as('alice').annotate(id, 'action', 'redflags', ['revisit', 'key'])
    expect((await as('alice').annotations(id)).body as PublicAnnotation[]).toEqual([
      { targetKind: 'action', targetId: 'redflags', marks: ['key', 'revisit'] },
      { targetKind: 'diagnosis', targetId: 'pneumonia', marks: ['ruled_out'] },
    ])
    res = await as('alice').annotate(id, 'action', 'redflags', [])
    expect(res.body).toEqual([{ targetKind: 'diagnosis', targetId: 'pneumonia', marks: ['ruled_out'] }])
  })

  it('rejects targets that are not in the pinned case, and other users', async () => {
    const id = await startedAttempt()
    const missing = await as('alice').annotate(id, 'diagnosis', 'not-in-this-case', ['key'])
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('annotation_target_not_found')
    expect((await as('alice').annotate(id, 'plan', 'redflags', ['key'])).status).toBe(404)
    expect((await as('alice').annotate(id, 'action', 'redflags', ['starred'])).status).toBe(400)
    expect((await as('bob').annotate(id, 'action', 'redflags', ['key'])).status).toBe(404)
    expect((await as('bob').annotations(id)).status).toBe(404)
  })
})
