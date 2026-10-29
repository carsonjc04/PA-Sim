import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'
import type { AvatarProvider } from './provider'

/**
 * Avatar + Voice pilot: offered on chest-pressure only, one avatar per voice session, never past the voice cap,
 * and billed minutes on the ledger and the attempt record. The provider is faked; the ledger and clock are real.
 */

const validSdp = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n${'a=candidate:placeholder\r\n'.repeat(10)}`
const MIN = 60_000
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
  guard: typeof import('../live/sessionGuard')
  avatarGuard: typeof import('./guard')
  starts: { maxSeconds: number; avatarId: string; sandbox: boolean }[]
  stops: string[]
  provider: { fail: boolean; credits: number | null }
  advance: (ms: number) => void
}

let rig: Rig
let offset = 0

async function boot(overrides: Record<string, string> = {}): Promise<Rig> {
  vi.resetModules()
  Object.assign(process.env, { OPENAI_API_KEY: 'sk-test-not-a-real-key', LIVEAVATAR_API_KEY: 'la-test-not-a-real-key', LIVE_SESSION_RATE_LIMIT: '100', ...overrides })
  const { createApp } = await import('../app')
  const { setOpenAIClient } = await import('../openai/client')
  const { setPool } = await import('../db/pool')
  const clock = await import('../lib/clock')
  const guard = await import('../live/sessionGuard')
  const ledger = await import('../live/ledger')
  const avatarGuard = await import('./guard')
  const { setAvatarProvider } = await import('./provider')
  setPool(db.pool)
  await db.reset()
  guard.resetSessionGuards()
  ledger.resetLedgerReservations()
  avatarGuard.setAvatarReportDelay(0)
  offset = 0
  clock.setClock(() => new Date(Date.now() + offset))
  guard.setSessionCloser({ close: async () => true })
  setOpenAIClient({
    live: { create: vi.fn().mockImplementation(async () => ({ session: { id: `live_sess_${randomUUID().replace(/-/g, '')}` }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer\r\n' } })) },
  } as never)
  const starts: Rig['starts'] = []
  const stops: string[] = []
  const state = { fail: false, credits: 2 as number | null }
  const fake: AvatarProvider = {
    start: async (input) => {
      if (state.fail) throw new Error('provider down')
      starts.push(input)
      return { avatarSessionId: randomUUID(), livekitUrl: 'wss://livekit.example', livekitClientToken: 'lk-client', wsUrl: 'wss://avatar.example/session', maxSeconds: input.maxSeconds }
    },
    stop: async (id) => {
      stops.push(id)
      return true
    },
    credits: async () => state.credits,
  }
  setAvatarProvider(fake)
  return { app: await listenLocal(createApp()), guard, avatarGuard, starts, stops, provider: state, advance: (ms) => void (offset += ms) }
}

afterEach(async () => {
  await rig?.guard.settleSessionGuards()
  await rig?.avatarGuard.settleAvatarGuards()
  rig?.guard.resetSessionGuards()
  for (const k of ['OPENAI_API_KEY', 'LIVEAVATAR_API_KEY', 'LIVEAVATAR_MAX_SESSION_SECONDS', 'LIVE_SESSION_RATE_LIMIT']) delete process.env[k]
  vi.resetModules()
})

const user = 'alice'
const encounter = async (scenarioId = 'chest-pressure') => (await request(rig.app).post('/api/attempts').set('X-Dev-User', user).send({ scenarioId })).body.attempt.id as string
const mint = async (attemptId: string) => (await request(rig.app).post('/api/live/session').set('X-Dev-User', user).send({ sdp: validSdp, attemptId })).body.sessionId as string
const avatar = (attemptId: string, sessionId: string) => request(rig.app).post('/api/live/avatar').set('X-Dev-User', user).send({ attemptId, sessionId })
const avatarEnd = (attemptId: string, sessionId: string, reason: 'client_end' | 'failed') =>
  request(rig.app).post('/api/live/avatar/end').set('X-Dev-User', user).send({ attemptId, sessionId, reason })
const activity = (attemptId: string, sessionId: string) => request(rig.app).post('/api/live/activity').set('X-Dev-User', user).send({ attemptId, sessionId })
const attempt = async (id: string) => (await request(rig.app).get(`/api/attempts/${id}`).set('X-Dev-User', user)).body
const row = async (sessionId: string) => (await db.pool.query('SELECT * FROM live_sessions WHERE session_id = $1', [sessionId])).rows[0]

describe('avatar offer per case', () => {
  it('lists only the pilot case, and only when the server has a LiveAvatar key', async () => {
    rig = await boot()
    expect((await request(rig.app).get('/api/ai/status')).body.avatarCaseIds).toEqual(['chest-pressure'])
    rig = await boot({ LIVEAVATAR_API_KEY: '' })
    expect((await request(rig.app).get('/api/ai/status')).body.avatarCaseIds).toEqual([])
  })

  it('refuses the avatar on a voice-only case', async () => {
    rig = await boot()
    const id = await encounter('asthma')
    const res = await avatar(id, await mint(id))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('avatar_not_offered')
    expect(rig.starts).toHaveLength(0)
  })

  it('never sends the LiveAvatar key to the browser', async () => {
    rig = await boot()
    const id = await encounter()
    const res = await avatar(id, await mint(id))
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('la-test-not-a-real-key')
    expect(JSON.stringify((await request(rig.app).get('/api/ai/status')).body)).not.toContain('la-test-not-a-real-key')
  })
})

describe('avatar within the voice cap', () => {
  it('caps the provider session at the plan ceiling or the voice time left, whichever is shorter', async () => {
    rig = await boot({ LIVEAVATAR_MAX_SESSION_SECONDS: '600' })
    const id = await encounter()
    const first = await mint(id)
    expect((await avatar(id, first)).status).toBe(200)
    expect(rig.starts[0].maxSeconds).toBe(600)

    // 18 of 20 voice minutes spent: the next session's avatar gets at most the 2 minutes left.
    for (let m = 0; m < 18; m += 1) {
      rig.advance(MIN)
      await activity(id, first)
    }
    const second = await mint(id) // replaces the first, which stops its avatar too
    await rig.guard.settleSessionGuards()
    expect(rig.stops).toHaveLength(1)
    expect((await avatar(id, second)).status).toBe(200)
    expect(rig.starts[1].maxSeconds).toBeLessThanOrEqual(120)
  })

  it('stops the avatar when the voice session reaches its cap, and refuses one after', async () => {
    rig = await boot({ LIVEAVATAR_MAX_SESSION_SECONDS: '1200' })
    const id = await encounter()
    const sessionId = await mint(id)
    expect((await avatar(id, sessionId)).status).toBe(200)
    for (let m = 0; m < 20; m += 1) {
      rig.advance(MIN)
      await activity(id, sessionId)
    }
    // The cap is hit: the leash closes voice, and the avatar goes with it.
    expect((await activity(id, sessionId)).status).toBe(409)
    await rig.guard.settleSessionGuards()
    await vi.waitFor(async () => expect((await row(sessionId)).avatar_end_reason).toBe('limit'))
    expect(rig.stops).toHaveLength(1)
    const r = await row(sessionId)
    expect(new Date(r.avatar_ended_at).getTime()).toBeLessThanOrEqual(new Date(r.deadline_at).getTime())
  })

  it('has the sweeper stop an avatar whose voice session is past its deadline', async () => {
    rig = await boot({ LIVEAVATAR_MAX_SESSION_SECONDS: '1200' })
    const id = await encounter()
    const sessionId = await mint(id)
    await avatar(id, sessionId)
    rig.advance(21 * MIN)
    await rig.guard.sweep()
    await rig.avatarGuard.settleAvatarGuards()
    expect(rig.stops).toHaveLength(1)
    expect((await row(sessionId)).avatar_ended_at).not.toBeNull()
  })

  it('allows one avatar per voice session, even under parallel requests', async () => {
    rig = await boot()
    const id = await encounter()
    const sessionId = await mint(id)
    const results = await Promise.all([avatar(id, sessionId), avatar(id, sessionId), avatar(id, sessionId)])
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.body.error?.code === 'avatar_already_started')).toHaveLength(2)
    expect(rig.starts).toHaveLength(1)
  })

  it('refuses an avatar for a voice session that is over', async () => {
    rig = await boot()
    const id = await encounter()
    const sessionId = await mint(id)
    await request(rig.app).post('/api/live/end').set('X-Dev-User', user).send({ attemptId: id, sessionId })
    expect((await avatar(id, sessionId)).body.error.code).toBe('live_session_ended')
    expect(rig.starts).toHaveLength(0)
  })
})

describe('avatar failure', () => {
  it('a provider failure at start leaves voice open and records no avatar minutes', async () => {
    rig = await boot()
    rig.provider.fail = true
    const id = await encounter()
    const sessionId = await mint(id)
    const res = await avatar(id, sessionId)
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('avatar_provider_unavailable')
    expect((await activity(id, sessionId)).status).toBe(200)
    const r = await row(sessionId)
    expect(r.ended_at).toBeNull()
    expect(r.avatar_end_reason).toBe('failed')
    expect((await attempt(id)).liveUsage.avatar).toBeNull()
  })

  it('a browser-reported failure stops the avatar only; voice keeps serving the case', async () => {
    rig = await boot()
    const id = await encounter()
    const sessionId = await mint(id)
    await avatar(id, sessionId)
    rig.advance(MIN)
    expect((await avatarEnd(id, sessionId, 'failed')).status).toBe(200)
    expect(rig.stops).toHaveLength(1)
    expect((await activity(id, sessionId)).status).toBe(200)
    expect((await row(sessionId)).ended_at).toBeNull()
  })
})

describe('avatar cost on the attempt record', () => {
  it('reports avatar minutes and the provider-reported credits as a plain estimate', async () => {
    rig = await boot()
    const id = await encounter()
    const sessionId = await mint(id)
    await avatar(id, sessionId)
    rig.advance(90_000)
    await activity(id, sessionId)
    await avatarEnd(id, sessionId, 'client_end')
    await rig.avatarGuard.settleAvatarGuards()
    const usage = (await attempt(id)).liveUsage
    expect(usage.avatar).toEqual({ minutes: 1.5, credits: 2, estimatedUsd: 0.2 })
    expect(usage.voiceMinutes).toBe(1.5)
  })

  it('estimates from minutes until the provider reports credits', async () => {
    rig = await boot()
    rig.provider.credits = null
    const id = await encounter()
    const sessionId = await mint(id)
    await avatar(id, sessionId)
    rig.advance(61_000)
    await avatarEnd(id, sessionId, 'client_end')
    await rig.avatarGuard.settleAvatarGuards()
    expect((await attempt(id)).liveUsage.avatar).toMatchObject({ credits: null, estimatedUsd: 0.1 })
  })

  it('is null for an attempt that never used voice', async () => {
    rig = await boot()
    expect((await attempt(await encounter())).liveUsage).toBeNull()
  })
})
