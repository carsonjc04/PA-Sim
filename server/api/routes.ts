import { Router } from 'express'
import { z } from 'zod'
import { gradeAttempt } from '../../src/domain/grading'
import { phaseOrder, type Attempt, type PhaseId } from '../../src/domain/types'
import { env, publicCapabilities } from '../config/env'
import { selectionsByPhase } from '../encounters/model'
import { toPublicEncounter, toPublicScenario } from '../encounters/projection'
import {
  EncounterError,
  createEncounter,
  deleteEncounter,
  listScenarios,
  requireEncounter,
} from '../encounters/store'
import { isToolName } from '../tools/contracts'
import { executeTool, retractEvent } from '../tools/execute'

const createBody = z.object({
  scenarioId: z.string().min(1),
  studentId: z.string().min(1).max(64).default('mock-student'),
  mode: z.enum(['guided', 'voice-handcrafted', 'voice-generated']).default('guided'),
})

function toAttempt(record: ReturnType<typeof requireEncounter>): Attempt {
  return {
    id: record.id,
    scenarioId: record.scenarioId,
    startedAt: record.createdAt,
    completedAt: record.submittedAt,
    selectedByPhase: selectionsByPhase(record),
    phaseLocks: record.lockedPhases,
    revealed: record.events
      .filter((e) => e.revealed)
      .map((e) => ({ phase: e.phase, actionId: e.id, text: e.revealed as string })),
    submitted: record.submitted,
  }
}

export const router: Router = Router()

router.get('/ai/status', (_req, res) => {
  res.json(publicCapabilities())
})

router.get('/scenarios', (_req, res) => {
  res.json(listScenarios().map(toPublicScenario))
})

router.post('/encounters', (req, res) => {
  const parsed = createBody.safeParse(req.body ?? {})
  if (!parsed.success) throw new EncounterError('Invalid request body', 400, 'invalid_body')
  if (parsed.data.mode !== 'guided' && !publicCapabilities().aiEnabled) {
    throw new EncounterError('AI voice mode is not configured on this server', 503, 'ai_unavailable')
  }
  const record = createEncounter({
    ...parsed.data,
    liveModel: env.OPENAI_LIVE_MODEL,
    reasoningModel: env.OPENAI_DELEGATE_MODEL,
  })
  res.status(201).json(toPublicEncounter(record))
})

router.get('/encounters/:id', (req, res) => {
  res.json(toPublicEncounter(requireEncounter(req.params.id)))
})

router.post('/encounters/:id/tools/:tool', (req, res) => {
  const { tool } = req.params
  if (!isToolName(tool)) throw new EncounterError('Unknown tool', 404, 'unknown_tool')
  const record = requireEncounter(req.params.id)
  const result = executeTool(record, tool, req.body ?? {})
  res.json({ result, encounter: toPublicEncounter(record) })
})

router.delete('/encounters/:id/events/:eventId', (req, res) => {
  const record = requireEncounter(req.params.id)
  retractEvent(record, req.params.eventId)
  res.json(toPublicEncounter(record))
})

router.post('/encounters/:id/phases/:phase/advance', (req, res) => {
  const record = requireEncounter(req.params.id)
  const phase = req.params.phase as PhaseId
  if (!phaseOrder.includes(phase)) throw new EncounterError('Unknown phase', 404, 'unknown_phase')
  if (record.submitted) throw new EncounterError('Encounter already submitted', 409, 'encounter_submitted')
  if (phase !== record.currentPhase) {
    throw new EncounterError('Only the current phase can be advanced', 409, 'wrong_phase')
  }
  // Idempotent: re-advancing a locked phase returns current state unchanged.
  if (!record.lockedPhases.includes(phase)) {
    record.lockedPhases.push(phase)
    const next = phaseOrder[phaseOrder.indexOf(phase) + 1]
    if (next) record.currentPhase = next
  }
  res.json(toPublicEncounter(record))
})

router.post('/encounters/:id/submit', (req, res) => {
  const record = requireEncounter(req.params.id)
  if (!record.submitted) {
    const selections = selectionsByPhase(record)
    if (selections.diagnosis.length === 0) {
      throw new EncounterError(
        'Confirm a primary diagnosis before submitting',
        409,
        'diagnosis_required',
      )
    }
    record.submitted = true
    record.submittedAt = new Date().toISOString()
    for (const phase of phaseOrder) {
      if (!record.lockedPhases.includes(phase)) record.lockedPhases.push(phase)
    }
  }
  // Deterministic and idempotent: the same event log always grades identically.
  const grade = gradeAttempt(record.hidden, toAttempt(record))
  res.json({ encounter: toPublicEncounter(record), grade })
})

router.delete('/encounters/:id', (req, res) => {
  const record = requireEncounter(req.params.id)
  deleteEncounter(record.id)
  res.json({ ok: true, durationSeconds: record.liveDurationSeconds ?? 0 })
})
