import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { getScenario, resetEncounters } from '../encounters/store'
import { setOpenAIClient } from '../openai/client'
import { resetRateLimit } from './live'

const validSdp = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n${'a=candidate:placeholder\r\n'.repeat(10)}`

async function newEncounter(app: ReturnType<typeof createApp>, mode = 'guided') {
  const res = await request(app)
    .post('/api/encounters')
    .send({ scenarioId: 'chest-pressure', mode })
  return res.body.id as string
}

describe('POST /api/live/session without a key', () => {
  beforeEach(() => {
    resetEncounters()
    resetRateLimit()
  })

  it('explains the setup instead of failing opaquely', async () => {
    const app = createApp()
    const id = await newEncounter(app)
    const res = await request(app).post('/api/live/session').send({ sdp: validSdp, encounterId: id })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('missing_api_key')
    expect(res.body.error.message).toContain('OPENAI_API_KEY')
  })

  it('leaves guided mode fully usable', async () => {
    const app = createApp()
    const id = await newEncounter(app)
    const target = getScenario('chest-pressure').phases[0].actions[0].id
    const res = await request(app)
      .post(`/api/encounters/${id}/tools/record_history_topics`)
      .send({ actionIds: [target] })
    expect(res.status).toBe(200)
    expect(res.body.result.recorded).toEqual([target])
  })
})

describe('POST /api/live/session with a key', () => {
  let app: ReturnType<typeof createApp>
  let create: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key'
    const { createApp: freshApp } = await import('../app')
    const { setOpenAIClient: setClient } = await import('../openai/client')
    const { resetEncounters: reset } = await import('../encounters/store')
    const { resetRateLimit: resetLimit } = await import('./live')
    reset()
    resetLimit()
    create = vi.fn().mockResolvedValue({
      session: { id: 'live_sess_123' },
      transport: { type: 'webrtc', sdp: 'v=0\r\nanswer-sdp\r\n' },
    })
    setClient({ live: { create } } as never)
    app = freshApp()
  })

  afterEach(() => {
    delete process.env.OPENAI_API_KEY
    setOpenAIClient(null)
    vi.resetModules()
  })

  it('returns only the session id and SDP answer', async () => {
    const id = await newEncounter(app, 'voice-handcrafted')
    const res = await request(app).post('/api/live/session').send({ sdp: validSdp, encounterId: id })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ sessionId: 'live_sess_123', sdp: 'v=0\r\nanswer-sdp\r\n' })
    // Nothing else may ride along to the browser.
    expect(Object.keys(res.body).sort()).toEqual(['sdp', 'sessionId'])
  })

  it('never returns the key or hidden case data', async () => {
    const id = await newEncounter(app, 'voice-handcrafted')
    const res = await request(app).post('/api/live/session').send({ sdp: validSdp, encounterId: id })
    const body = JSON.stringify(res.body)
    const scenario = getScenario('chest-pressure')

    expect(body).not.toContain('sk-test')
    expect(body).not.toContain(scenario.correctPrimary)
    for (const rule of scenario.criticalRules) expect(body).not.toContain(rule.explanation)
  })

  it('sends Responses delegation with the configured models and case tools', async () => {
    const id = await newEncounter(app, 'voice-handcrafted')
    await request(app).post('/api/live/session').send({ sdp: validSdp, encounterId: id })

    const params = create.mock.calls[0][0]
    expect(params.session.model).toBe('gpt-live-1')
    expect(params.transport).toEqual({ type: 'webrtc', sdp: validSdp })
    expect(params.session.delegation.type).toBe('responses')
    expect(params.session.delegation.responses.model).toBe('gpt-5.6-terra')
    expect(params.session.delegation.responses.tools.length).toBeGreaterThan(0)
    expect(params.session.delegation.responses.parallel_tool_calls).toBe(false)
  })

  it('keeps the answer key out of the patient prompt', async () => {
    const id = await newEncounter(app, 'voice-handcrafted')
    await request(app).post('/api/live/session').send({ sdp: validSdp, encounterId: id })

    const instructions = create.mock.calls[0][0].session.instructions as string
    const scenario = getScenario('chest-pressure')
    for (const rule of scenario.criticalRules) expect(instructions).not.toContain(rule.explanation)
    for (const point of scenario.teachingPoints) expect(instructions).not.toContain(point)
    // A patient cannot report their own exam findings or test results.
    const examFindings = scenario.phases
      .filter((p) => p.id === 'exam' || p.id === 'diagnostics')
      .flatMap((p) => p.actions.map((a) => a.response))
    for (const finding of examFindings) expect(instructions).not.toContain(finding)
  })

  it('rejects a malformed SDP and an unknown encounter', async () => {
    const short = await request(app)
      .post('/api/live/session')
      .send({ sdp: 'nope', encounterId: '00000000-0000-4000-8000-000000000000' })
    expect(short.status).toBe(400)

    const missing = await request(app)
      .post('/api/live/session')
      .send({ sdp: validSdp, encounterId: '00000000-0000-4000-8000-000000000000' })
    expect(missing.status).toBe(404)
    expect(create).not.toHaveBeenCalled()
  })

  it('maps a provider auth failure to a sanitized message', async () => {
    create.mockRejectedValueOnce(Object.assign(new Error('Incorrect API key sk-live-real'), { status: 401 }))
    const id = await newEncounter(app, 'voice-handcrafted')
    const res = await request(app).post('/api/live/session').send({ sdp: validSdp, encounterId: id })

    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('provider_auth_failed')
    expect(JSON.stringify(res.body)).not.toContain('sk-live-real')
  })

  it('rate limits session creation because each session is billed', async () => {
    const id = await newEncounter(app, 'voice-handcrafted')
    const codes: number[] = []
    for (let i = 0; i < 7; i += 1) {
      const res = await request(app)
        .post('/api/live/session')
        .send({ sdp: validSdp, encounterId: id })
      codes.push(res.status)
    }
    expect(codes).toContain(429)
  })

  it('executes relayed tool calls server-side and rejects unknown tools', async () => {
    const id = await newEncounter(app, 'voice-handcrafted')
    const target = getScenario('chest-pressure').phases[0].actions[0].id

    const ok = await request(app).post('/api/live/tool').send({
      encounterId: id,
      callId: 'call_1',
      name: 'record_history_topics',
      arguments: JSON.stringify({ actionIds: [target] }),
    })
    expect(ok.status).toBe(200)
    expect(ok.body.output.ok).toBe(true)
    expect(ok.body.output.findings[0].id).toBe(target)

    const bad = await request(app).post('/api/live/tool').send({
      encounterId: id,
      callId: 'call_2',
      name: 'reveal_the_diagnosis',
      arguments: '{}',
    })
    expect(bad.status).toBe(400)
  })

  it('returns a rejected tool call as a normal result so the conversation continues', async () => {
    const id = await newEncounter(app, 'voice-handcrafted')
    const res = await request(app).post('/api/live/tool').send({
      encounterId: id,
      callId: 'call_3',
      name: 'record_history_topics',
      arguments: JSON.stringify({ actionIds: ['not-a-real-action'] }),
    })
    expect(res.status).toBe(200)
    expect(res.body.output.ok).toBe(false)
  })
})
