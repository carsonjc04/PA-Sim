import type { Server } from 'node:http'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { scenarios } from '../content/scenarios'
import type { ScenarioDefinition } from '../../src/domain/types'
import { createApp } from '../app'
import { setOpenAIClient } from '../openai/client'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'
import { resetRateLimit } from './live'

const validSdp = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n${'a=candidate:placeholder\r\n'.repeat(10)}`
const getScenario = (id: string) => scenarios.find((s) => s.id === id) as ScenarioDefinition
const USER = 'alice'

let db: TestDatabase
beforeAll(async () => {
  db = await createTestDatabase()
})
afterAll(async () => {
  await closeLocalServers()
  await db.close()
})

async function newEncounter(app: Server) {
  const res = await request(app).post('/api/attempts').set('X-Dev-User', USER).send({ scenarioId: 'chest-pressure' })
  return res.body.attempt.id as string
}

const session = (app: Server, body: object) =>
  request(app).post('/api/live/session').set('X-Dev-User', USER).send(body)
const tool = (app: Server, body: object) =>
  request(app).post('/api/live/tool').set('X-Dev-User', USER).send(body)

describe('POST /api/live/session without a key', () => {
  beforeEach(async () => {
    await db.reset()
    resetRateLimit()
  })

  it('explains the setup instead of failing opaquely', async () => {
    const app = await listenLocal(createApp())
    const id = await newEncounter(app)
    const res = await session(app, { sdp: validSdp, attemptId: id })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('missing_api_key')
    expect(res.body.error.message).toContain('OPENAI_API_KEY')
  })

  it('leaves guided mode fully usable', async () => {
    const app = await listenLocal(createApp())
    const id = await newEncounter(app)
    const target = getScenario('chest-pressure').phases[0].actions[0].id
    const res = await request(app)
      .post(`/api/attempts/${id}/events`)
      .set('X-Dev-User', USER)
      .set('Idempotency-Key', 'guided-key-0001')
      .send({ type: 'action', tool: 'record_history_topics', actionIds: [target] })
    expect(res.status).toBe(200)
    expect(res.body.result.recorded).toEqual([target])
  })
})

describe('POST /api/live/session with a key', () => {
  let app: Server
  let create: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key'
    const { createApp: freshApp } = await import('../app')
    const { setOpenAIClient: setClient } = await import('../openai/client')
    const { setPool } = await import('../db/pool')
    const { resetRateLimit: resetLimit } = await import('./live')
    const guard = await import('../live/sessionGuard')
    guard.setSessionCloser({ close: async () => true })
    setPool(db.pool)
    await db.reset()
    resetLimit()
    let k = 0
    create = vi.fn().mockImplementation(async () => ({
      session: { id: k === 0 ? ((k += 1), 'live_sess_123') : `live_sess_${(k += 1)}` },
      transport: { type: 'webrtc', sdp: 'v=0\r\nanswer-sdp\r\n' },
    }))
    setClient({ live: { create } } as never)
    app = await listenLocal(freshApp())
  })

  afterEach(async () => {
    await (await import('../live/sessionGuard')).settleSessionGuards()
    delete process.env.OPENAI_API_KEY
    setOpenAIClient(null)
    vi.resetModules()
  })

  it('returns only the session id and SDP answer', async () => {
    const id = await newEncounter(app)
    const res = await session(app, { sdp: validSdp, attemptId: id })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sessionId: 'live_sess_123', sdp: 'v=0\r\nanswer-sdp\r\n' })
    // Nothing else may ride along to the browser; the deadline is the server's, not a secret.
    expect(Object.keys(res.body).sort()).toEqual(['deadlineAt', 'sdp', 'sessionId'])
  })

  it('never returns the key or hidden case data', async () => {
    const id = await newEncounter(app)
    const res = await session(app, { sdp: validSdp, attemptId: id })
    const body = JSON.stringify(res.body)
    const scenario = getScenario('chest-pressure')

    expect(body).not.toContain('sk-test')
    expect(body).not.toContain(scenario.correctPrimary)
    for (const rule of scenario.criticalRules) expect(body).not.toContain(rule.explanation)
  })

  it('sends Responses delegation with the configured models and case tools', async () => {
    const id = await newEncounter(app)
    await session(app, { sdp: validSdp, attemptId: id })

    const params = create.mock.calls[0][0]
    expect(params.session.model).toBe('gpt-live-1')
    expect(params.transport).toEqual({ type: 'webrtc', sdp: validSdp })
    expect(params.session.delegation.type).toBe('responses')
    expect(params.session.delegation.responses.model).toBe('gpt-5.6-terra')
    expect(params.session.delegation.responses.tools.length).toBeGreaterThan(0)
    expect(params.session.delegation.responses.parallel_tool_calls).toBe(false)
  })

  it('keeps the answer key out of the patient prompt', async () => {
    const id = await newEncounter(app)
    await session(app, { sdp: validSdp, attemptId: id })

    const instructions = create.mock.calls[0][0].session.instructions as string
    const scenario = getScenario('chest-pressure')
    for (const rule of scenario.criticalRules) expect(instructions).not.toContain(rule.explanation)
    for (const point of scenario.teachingPoints) expect(instructions).not.toContain(point)
    // A patient cannot report their own exam findings or test results.
    const examFindings = scenario.phases
      .filter((p) => p.id === 'exam' || p.id === 'diagnostics')
      .flatMap((p) => p.actions.map((a) => a.response))
    for (const finding of examFindings) expect(instructions).not.toContain(finding)
    // History facts too: each is released only by the server tool, so a spent budget releases nothing.
    for (const action of scenario.phases.find((p) => p.id === 'history')!.actions) expect(instructions).not.toContain(action.response)
  })

  it('rejects a malformed SDP and an unknown attempt', async () => {
    const short = await session(app, { sdp: 'nope', attemptId: '00000000-0000-4000-8000-000000000000' })
    expect(short.status).toBe(400)

    const missing = await session(app, { sdp: validSdp, attemptId: '00000000-0000-4000-8000-000000000000' })
    expect(missing.status).toBe(404)
    expect(create).not.toHaveBeenCalled()
  })

  it('maps a provider auth failure to a sanitized message', async () => {
    create.mockRejectedValueOnce(Object.assign(new Error('Incorrect API key sk-live-real'), { status: 401 }))
    const id = await newEncounter(app)
    const res = await session(app, { sdp: validSdp, attemptId: id })

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('provider_auth_failed')
    expect(JSON.stringify(res.body)).not.toContain('sk-live-real')
  })

  it('rate limits session creation because each session is billed', async () => {
    const id = await newEncounter(app)
    const codes: number[] = []
    for (let i = 0; i < 7; i += 1) {
      const res = await session(app, { sdp: validSdp, attemptId: id })
      codes.push(res.status)
    }
    expect(codes).toContain(429)
  })

  it('executes relayed tool calls server-side and rejects unknown tools', async () => {
    const id = await newEncounter(app)
    const target = getScenario('chest-pressure').phases[0].actions[0].id
    const { sessionId } = (await session(app, { sdp: validSdp, attemptId: id })).body

    const ok = await tool(app, {
      attemptId: id,
      sessionId,
      callId: 'call_1',
      name: 'record_history_topics',
      arguments: JSON.stringify({ actionIds: [target] }),
    })
    expect(ok.status).toBe(200)
    expect(ok.body.output.ok).toBe(true)
    expect(ok.body.output.findings[0].id).toBe(target)

    const bad = await tool(app, {
      attemptId: id,
      sessionId,
      callId: 'call_2',
      name: 'reveal_the_diagnosis',
      arguments: '{}',
    })
    expect(bad.status).toBe(400)
  })

  it('records a retried relay of the same call ID once', async () => {
    const id = await newEncounter(app)
    const target = getScenario('chest-pressure').phases[0].actions[0].id
    const { sessionId } = (await session(app, { sdp: validSdp, attemptId: id })).body
    const call = { attemptId: id, sessionId, callId: 'call_retry', name: 'record_history_topics', arguments: JSON.stringify({ actionIds: [target] }) }
    const first = await tool(app, call)
    const retry = await tool(app, call)
    expect(retry.body).toEqual(first.body)
    expect(first.body.output.recorded).toEqual([target])

    const attempt = await request(app).get(`/api/attempts/${id}`).set('X-Dev-User', USER)
    expect(attempt.body.events).toHaveLength(1)
    expect(attempt.body.events[0].source).toBe('voice')
  })

  it('returns a rejected tool call as a normal result so the conversation continues', async () => {
    const id = await newEncounter(app)
    const { sessionId } = (await session(app, { sdp: validSdp, attemptId: id })).body
    const res = await tool(app, {
      attemptId: id,
      sessionId,
      callId: 'call_3',
      name: 'record_history_topics',
      arguments: JSON.stringify({ actionIds: ['not-a-real-action'] }),
    })
    expect(res.status).toBe(200)
    expect(res.body.output.ok).toBe(false)
  })
})

