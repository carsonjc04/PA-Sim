import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { getScenario, resetEncounters } from '../encounters/store'

const app = createApp()
const scenario = getScenario('chest-pressure')
const actionIn = (phase: string, index = 0) =>
  scenario.phases.find((p) => p.id === phase)!.actions[index].id

async function startEncounter() {
  const res = await request(app)
    .post('/api/encounters')
    .send({ scenarioId: 'chest-pressure', mode: 'guided' })
  return res.body.id as string
}

const call = (id: string, tool: string, body: object) =>
  request(app).post(`/api/encounters/${id}/tools/${tool}`).send(body)

describe('encounter API', () => {
  beforeEach(resetEncounters)

  it('reports AI as unavailable without a configured key', async () => {
    const res = await request(app).get('/api/ai/status')
    expect(res.status).toBe(200)
    expect(res.body.aiEnabled).toBe(false)
    expect(res.body.setupHint).toContain('OPENAI_API_KEY')
    expect(JSON.stringify(res.body)).not.toContain('sk-')
  })

  it('refuses voice mode when no key is configured but allows guided mode', async () => {
    const voice = await request(app)
      .post('/api/encounters')
      .send({ scenarioId: 'chest-pressure', mode: 'voice-handcrafted' })
    expect(voice.status).toBe(503)

    const guided = await request(app)
      .post('/api/encounters')
      .send({ scenarioId: 'chest-pressure', mode: 'guided' })
    expect(guided.status).toBe(201)
  })

  it('rejects an action ID that is not in the scenario', async () => {
    const id = await startEncounter()
    const res = await call(id, 'record_history_topics', { actionIds: ['not-a-real-action'] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('unknown_action')
  })

  it('rejects an action belonging to a later phase', async () => {
    const id = await startEncounter()
    const res = await call(id, 'record_history_topics', { actionIds: [actionIn('exam')] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('unknown_action')
  })

  it('rejects a tool that does not belong to the current phase', async () => {
    const id = await startEncounter()
    const res = await call(id, 'request_physical_exam', { actionIds: [actionIn('exam')] })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('wrong_phase')
  })

  it('is idempotent so one action cannot be scored twice', async () => {
    const id = await startEncounter()
    const target = actionIn('history')
    const first = await call(id, 'record_history_topics', { actionIds: [target] })
    expect(first.body.result.recorded).toEqual([target])

    const second = await call(id, 'record_history_topics', { actionIds: [target] })
    expect(second.body.result.recorded).toEqual([])
    expect(second.body.result.duplicates).toEqual([target])
    expect(second.body.encounter.events.filter((e: { id: string }) => e.id === target)).toHaveLength(1)
  })

  it('releases the patient response only after the action is performed', async () => {
    const id = await startEncounter()
    const target = actionIn('history')
    const expected = scenario.phases.find((p) => p.id === 'history')!.actions[0].response

    const before = await request(app).get(`/api/encounters/${id}`)
    expect(JSON.stringify(before.body)).not.toContain(expected)

    const after = await call(id, 'record_history_topics', { actionIds: [target] })
    expect(after.body.result.reveals[0].text).toBe(expected)
  })

  it('rejects mutation of a locked phase', async () => {
    const id = await startEncounter()
    await request(app).post(`/api/encounters/${id}/phases/history/advance`)
    const res = await call(id, 'record_history_topics', { actionIds: [actionIn('history')] })
    expect(res.status).toBe(409)
    expect(['phase_locked', 'wrong_phase']).toContain(res.body.error.code)
  })

  it('advancing the same phase twice does not skip a phase', async () => {
    const id = await startEncounter()
    const first = await request(app).post(`/api/encounters/${id}/phases/history/advance`)
    expect(first.body.currentPhase).toBe('exam')
    const again = await request(app).post(`/api/encounters/${id}/phases/history/advance`)
    expect(again.status).toBe(409)
  })

  it('keeps an unconfirmed diagnosis out of the graded event log', async () => {
    const id = await startEncounter()
    for (const phase of ['history', 'exam', 'diagnostics']) {
      await request(app).post(`/api/encounters/${id}/phases/${phase}/advance`)
    }
    const target = scenario.diagnoses[0].id

    const proposed = await call(id, 'propose_diagnosis', { actionIds: [target], confirmed: false })
    expect(proposed.body.result.pendingConfirmation).toEqual([target])
    expect(proposed.body.result.recorded).toEqual([])
    expect(proposed.body.encounter.events).toHaveLength(0)

    const confirmed = await call(id, 'propose_diagnosis', { actionIds: [target], confirmed: true })
    expect(confirmed.body.result.recorded).toEqual([target])
  })

  it('refuses to submit without a confirmed diagnosis', async () => {
    const id = await startEncounter()
    const res = await request(app).post(`/api/encounters/${id}/submit`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('diagnosis_required')
  })

  it('grades deterministically and caps a critical safety error at 59', async () => {
    const id = await startEncounter()
    for (const phase of ['history', 'exam', 'diagnostics']) {
      await request(app).post(`/api/encounters/${id}/phases/${phase}/advance`)
    }
    await call(id, 'propose_diagnosis', { actionIds: [scenario.correctPrimary], confirmed: true })
    await request(app).post(`/api/encounters/${id}/phases/diagnosis/advance`)

    const unsafe = scenario.planOptions.find((p) => p.unsafe)
    expect(unsafe, 'chest-pressure scenario should define an unsafe plan option').toBeTruthy()
    await call(id, 'propose_treatment_plan', { actionIds: [unsafe!.id], confirmed: true }).catch(
      () => undefined,
    )
    await call(id, 'record_disposition', { actionIds: [unsafe!.id], confirmed: true }).catch(
      () => undefined,
    )

    const first = await request(app).post(`/api/encounters/${id}/submit`)
    expect(first.status).toBe(200)
    const second = await request(app).post(`/api/encounters/${id}/submit`)
    expect(second.body.grade).toEqual(first.body.grade)

    if (first.body.grade.criticalSafetyError) {
      expect(first.body.grade.finalScore).toBeLessThanOrEqual(59)
      expect(first.body.grade.passed).toBe(false)
    }
  })

  it('never returns the answer key from the submit-time encounter payload', async () => {
    const id = await startEncounter()
    for (const phase of ['history', 'exam', 'diagnostics']) {
      await request(app).post(`/api/encounters/${id}/phases/${phase}/advance`)
    }
    await call(id, 'propose_diagnosis', { actionIds: [scenario.correctPrimary], confirmed: true })
    const res = await request(app).post(`/api/encounters/${id}/submit`)
    const encounterJson = JSON.stringify(res.body.encounter)
    for (const rule of scenario.criticalRules) {
      expect(encounterJson).not.toContain(rule.explanation)
    }
  })
})
