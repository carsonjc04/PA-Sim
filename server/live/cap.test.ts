import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ScenarioDefinition } from '../../src/domain/types'
import { scenarios } from '../content/scenarios'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'

/**
 * The 20-minute voice cap against a hostile client: one that ignores its own timer, keeps the WebRTC
 * connection open, never sends End session, reconnects, switches identity and fires parallel requests.
 * Every check here runs on the server clock and the ledger; the browser is not involved.
 */

const validSdp = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n${'a=candidate:placeholder\r\n'.repeat(10)}`
const scenario = scenarios.find((s) => s.id === 'chest-pressure') as ScenarioDefinition
const historyIds = scenario.phases.find((p) => p.id === 'history')!.actions.map((a) => a.id)
const MIN = 60_000

// Each case makes up to ~40 sequential HTTP calls against a real database; 5 s is too tight under a loaded suite.
vi.setConfig({ testTimeout: 20_000 })

let db: TestDatabase
beforeAll(async () => {
  db = await createTestDatabase()
})
afterAll(async () => {
  await closeLocalServers()
  await db.close()
})

interface Rig {
  app: Server
  guard: typeof import('./sessionGuard')
  ledger: typeof import('./ledger')
  /** Session IDs the server asked the provider to close. */
  closed: string[]
  /** Set false to simulate a provider that does not confirm closes. */
  confirm: { value: boolean }
  advance: (ms: number) => void
}

let rig: Rig
let offset = 0

async function boot(overrides: Record<string, string> = {}): Promise<Rig> {
  vi.resetModules()
  Object.assign(process.env, { OPENAI_API_KEY: 'sk-test-not-a-real-key', LIVE_SESSION_RATE_LIMIT: '100', ...overrides })
  const { createApp } = await import('../app')
  const { setOpenAIClient } = await import('../openai/client')
  const { setPool } = await import('../db/pool')
  const clock = await import('../lib/clock')
  const guard = await import('./sessionGuard')
  const ledger = await import('./ledger')
  setPool(db.pool)
  await db.reset()
  guard.resetSessionGuards()
  ledger.resetLedgerReservations()
  offset = 0
  clock.setClock(() => new Date(Date.now() + offset))
  const closed: string[] = []
  const confirm = { value: true }
  guard.setSessionCloser({
    close: async (id) => {
      closed.push(id)
      return confirm.value
    },
  })
  // Unique across boots, so a close still finishing from an earlier test can never touch this test's rows.
  const create = vi.fn().mockImplementation(async () => ({ session: { id: `live_sess_${randomUUID().replace(/-/g, '')}` }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer\r\n' } }))
  setOpenAIClient({ live: { create } } as never)
  return { app: await listenLocal(createApp()), guard, ledger, closed, confirm, advance: (ms) => void (offset += ms) }
}

afterEach(async () => {
  await rig?.guard.settleSessionGuards()
  rig?.guard.resetSessionGuards()
  for (const k of ['OPENAI_API_KEY', 'LIVE_SESSION_RATE_LIMIT', 'LIVE_MAX_SESSIONS_PER_CLIENT', 'LIVE_MAX_CONCURRENT_SESSIONS']) delete process.env[k]
  vi.resetModules()
})

const as = (user: string) => ({
  encounter: async (scenarioId = 'chest-pressure') =>
    (await request(rig.app).post('/api/attempts').set('X-Dev-User', user).send({ scenarioId })).body.attempt.id as string,
  mint: (attemptId: string) => request(rig.app).post('/api/live/session').set('X-Dev-User', user).send({ sdp: validSdp, attemptId }),
  tool: (attemptId: string, sessionId: string, actionId = historyIds[0]) =>
    request(rig.app)
      .post('/api/live/tool')
      .set('X-Dev-User', user)
      .send({ attemptId, sessionId, callId: `call_${Math.random().toString(36).slice(2)}`, name: 'record_history_topics', arguments: JSON.stringify({ actionIds: [actionId] }) }),
  activity: (attemptId: string, sessionId: string) => request(rig.app).post('/api/live/activity').set('X-Dev-User', user).send({ attemptId, sessionId }),
  end: (attemptId: string, sessionId: string) => request(rig.app).post('/api/live/end').set('X-Dev-User', user).send({ attemptId, sessionId }),
})

const recordedActions = async (attemptId: string) =>
  (await db.pool.query("SELECT count(*)::int AS n FROM attempt_events WHERE attempt_id = $1 AND type = 'action'", [attemptId])).rows[0].n as number
const row = async (sessionId: string) => (await db.pool.query('SELECT * FROM live_sessions WHERE session_id = $1', [sessionId])).rows[0]

/** Keeps the session from going idle while the clock is moved, as a talkative client would. */
async function talkFor(minutes: number, attemptId: string, sessionId: string, user = 'alice') {
  for (let m = 0; m < minutes; m += 1) {
    rig.advance(MIN)
    await as(user).activity(attemptId, sessionId)
  }
}

describe('tools leash', () => {
  it('releases findings inside the budget and refuses them the moment it expires, even to a client that keeps talking', async () => {
    rig = await boot()
    const alice = as('alice')
    const id = await alice.encounter()
    const { sessionId } = (await alice.mint(id)).body
    expect((await alice.tool(id, sessionId)).body.output.findings).toHaveLength(1)

    await talkFor(19, id, sessionId)
    expect((await alice.tool(id, sessionId, historyIds[1])).body.output.ok).toBe(true)

    rig.advance(MIN) // exactly 20 minutes of session time
    const late = await alice.tool(id, sessionId, historyIds[2])
    expect(late.status).toBe(409)
    expect(late.body.error.code).toBe('live_session_expired')
    expect(JSON.stringify(late.body)).not.toContain(scenario.phases[0].actions[2].response)
    expect(await recordedActions(id)).toBe(2)
    await vi.waitFor(() => expect(rig.closed).toEqual([sessionId]))
    expect((await row(sessionId)).end_reason).toBe('limit')

    // Heartbeats are refused too, so a hostile client cannot keep a spent session "active".
    expect((await alice.activity(id, sessionId)).body.error.code).toBe('live_session_ended')
  })

  it('refuses a missing session, a forged one, and another attempt’s session', async () => {
    rig = await boot()
    const alice = as('alice')
    const a = await alice.encounter()
    const b = await alice.encounter('asthma')
    const { sessionId } = (await alice.mint(a)).body
    expect((await alice.tool(a, 'live_sess_forged')).body.error.code).toBe('live_session_required')
    expect((await alice.tool(b, sessionId)).body.error.code).toBe('live_session_required')
    expect(await recordedActions(a)).toBe(0)
    expect(await recordedActions(b)).toBe(0)
  })

  it('reveals nothing about another user’s attempt', async () => {
    rig = await boot()
    const id = await as('alice').encounter()
    const { sessionId } = (await as('alice').mint(id)).body
    expect((await as('mallory').tool(id, sessionId)).status).toBe(404)
  })
})

describe('per-encounter budget', () => {
  it('is cumulative across reconnects: a new session gets only the time left, then minting is refused', async () => {
    rig = await boot()
    const alice = as('alice')
    const id = await alice.encounter()
    const first = (await alice.mint(id)).body
    await talkFor(15, id, first.sessionId)
    // Reconnect: the old session is replaced, and the new deadline is the remaining 5 minutes, not 20.
    const second = (await alice.mint(id)).body
    await vi.waitFor(() => expect(rig.closed).toContain(first.sessionId))
    const left = Date.parse(second.deadlineAt) - (Date.now() + 15 * MIN)
    expect(left).toBeGreaterThan(4.9 * MIN)
    expect(left).toBeLessThanOrEqual(5 * MIN + 1000)

    await talkFor(4, id, second.sessionId)
    rig.advance(MIN)
    expect((await alice.tool(id, second.sessionId)).body.error.code).toBe('live_session_expired')
    const again = await alice.mint(id)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('live_budget_spent')
  })
})

describe('ledger sweeper', () => {
  it('records every minted session with user, attempt and start time', async () => {
    rig = await boot()
    const id = await as('alice').encounter()
    const { sessionId } = (await as('alice').mint(id)).body
    const r = await row(sessionId)
    expect(r).toMatchObject({ attempt_id: id, ended_at: null, flagged_at: null })
    expect(r.user_id).toBeTruthy()
    expect(r.client_key).toMatch(/^[0-9a-f]{64}$/)
    expect(new Date(r.deadline_at).getTime() - new Date(r.started_at).getTime()).toBe(20 * MIN)
  })

  it('flags a session still open past the cap and blocks that user and address from minting until the close is confirmed', async () => {
    rig = await boot()
    const alice = as('alice')
    const id = await alice.encounter()
    const { sessionId } = (await alice.mint(id)).body
    rig.confirm.value = false // the provider does not acknowledge the close

    await talkFor(21, id, sessionId)
    expect(await rig.guard.sweep()).toMatchObject({ expired: 1 })
    expect((await row(sessionId)).flagged_at).not.toBeNull()
    expect((await row(sessionId)).ended_at).toBeNull()

    // Same user, a different encounter: blocked.
    const other = await alice.encounter('asthma')
    expect((await alice.mint(other)).body.error.code).toBe('live_session_unresolved')
    // A new identity from the same address: blocked too.
    const mallory = as('mallory')
    expect((await mallory.mint(await mallory.encounter())).body.error.code).toBe('live_session_unresolved')

    // The next sweep gets confirmation; the block lifts.
    rig.confirm.value = true
    await rig.guard.sweep()
    expect((await row(sessionId)).ended_at).not.toBeNull()
    expect((await alice.mint(other)).status).toBe(200)
  })

  it('stops blocking on a close that is never confirmed once the provider must have ended it', async () => {
    rig = await boot()
    const id = await as('alice').encounter()
    const { sessionId } = (await as('alice').mint(id)).body
    rig.confirm.value = false
    rig.advance(20 * MIN + 61 * MIN)
    expect(await rig.guard.sweep()).toMatchObject({ assumed: 1 })
    expect((await row(sessionId)).end_reason).toBe('assumed_expired')
  })

  it('ends an abandoned tab: no speech for the idle timeout and the sweeper closes it', async () => {
    rig = await boot()
    const alice = as('alice')
    const id = await alice.encounter()
    const { sessionId } = (await alice.mint(id)).body
    rig.advance(90_000)
    expect((await rig.guard.sweep()).idle).toBe(0)
    expect((await alice.activity(id, sessionId)).status).toBe(200) // speech resets the idle clock
    rig.advance(110_000)
    expect((await rig.guard.sweep()).idle).toBe(0)
    rig.advance(11_000) // 121 s of silence
    expect((await alice.tool(id, sessionId)).body.error.code).toBe('live_session_idle')
    await rig.guard.sweep()
    await vi.waitFor(async () => expect((await row(sessionId)).end_reason).toBe('idle'))
    expect(rig.closed).toEqual([sessionId])
  })

  it('re-arms open sessions after a restart and closes them at their deadline', async () => {
    rig = await boot()
    const id = await as('alice').encounter()
    const { sessionId } = (await as('alice').mint(id)).body
    rig.guard.resetSessionGuards() // the process restarted: timers are gone
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      expect((await rig.guard.startSessionGuards()).armed).toBe(1)
      await vi.advanceTimersByTimeAsync(20 * MIN + 1000)
      expect(rig.closed).toEqual([sessionId])
    } finally {
      rig.guard.resetSessionGuards()
      vi.useRealTimers()
    }
  })
})

describe('mint limits', () => {
  it('starting a session closes the same user’s other open session, so one user has one meter', async () => {
    rig = await boot()
    const alice = as('alice')
    const a = (await alice.mint(await alice.encounter())).body.sessionId
    await alice.mint(await alice.encounter('asthma'))
    await vi.waitFor(() => expect(rig.closed).toEqual([a]))
    expect((await row(a)).end_reason).toBe('replaced')
  })

  it('caps open sessions per address, even across identities', async () => {
    rig = await boot()
    for (const user of ['u1', 'u2']) expect((await as(user).mint(await as(user).encounter())).status).toBe(200)
    const third = await as('u3').mint(await as('u3').encounter())
    expect(third.status).toBe(429)
    expect(third.body.error.code).toBe('live_client_limit')
  })

  it('caps open sessions server-wide, and a parallel burst cannot slip past the check', async () => {
    rig = await boot({ LIVE_MAX_SESSIONS_PER_CLIENT: '50', LIVE_MAX_CONCURRENT_SESSIONS: '3' })
    const users = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']
    const ids = await Promise.all(users.map((u) => as(u).encounter()))
    const results = await Promise.all(users.map((u, i) => as(u).mint(ids[i])))
    expect(results.filter((r) => r.status === 200)).toHaveLength(3)
    expect(results.filter((r) => r.body.error?.code === 'live_capacity')).toHaveLength(3)
  })

  it('End session closes on the server and frees the slot at once', async () => {
    rig = await boot()
    const u1 = as('u1')
    const id = await u1.encounter()
    const { sessionId } = (await u1.mint(id)).body
    await as('u2').mint(await as('u2').encounter())
    expect((await u1.end(id, sessionId)).body).toEqual({ ok: true, confirmed: true })
    expect((await row(sessionId)).end_reason).toBe('client_end')
    expect((await as('u3').mint(await as('u3').encounter())).status).toBe(200)
  })
})
