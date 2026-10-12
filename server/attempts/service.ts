import type {
  AttemptEventBody,
  EventResponse,
  EventResult,
  HistoryPage,
  HistoryQuery,
  PublicAttempt,
  StartAttemptResponse,
} from '../../src/api/contracts'
import { gradeAttempt } from '../../src/domain/grading'
import { phaseOrder, type Attempt, type PhaseId, type ScenarioDefinition } from '../../src/domain/types'
import type { AuthContext } from '../auth/context'
import { GRADING_VERSION, canonicalJson, currentContent, sha256 } from '../content/versions'
import { getPool, withTransaction, type Queryable } from '../db/pool'
import { ApiError } from '../http/errors'
import { now } from '../lib/clock'
import { confidenceOf, deriveRemediationSafely } from '../review/derive'
import { planTool } from '../tools/execute'
import { toAttemptSummary, toPublicAttempt } from './projection'
import * as repo from './repository'

const notFound = () => new ApiError('Attempt not found.', 404, 'attempt_not_found')

async function snapshot(q: Queryable, attempt: repo.AttemptRow): Promise<PublicAttempt> {
  const scenario = await repo.getContentDefinition(q, attempt.contentVersionId)
  const events = await repo.listLiveEvents(q, attempt.id)
  const result = attempt.status === 'submitted' ? await repo.getResult(q, attempt.id) : null
  return toPublicAttempt(attempt, scenario, events, result)
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505'
}

/** Returns the user's active attempt for the scenario, or creates one pinned to the current content version. */
export async function startAttempt(auth: AuthContext, scenarioId: string): Promise<StartAttemptResponse> {
  const content = currentContent(scenarioId)
  const pool = getPool()
  try {
    return await withTransaction(pool, async (q) => {
      const existing = await repo.findActiveAttempt(q, auth.userId, scenarioId)
      if (existing) return { attempt: await snapshot(q, existing), resumed: true }
      await repo.ensureContentVersion(q, content)
      const created = await repo.insertAttempt(q, {
        userId: auth.userId,
        scenarioId,
        contentVersionId: content.id,
        firstPhase: phaseOrder[0],
      })
      return { attempt: await snapshot(q, created), resumed: false }
    })
  } catch (error) {
    // Two concurrent starts: the loser resumes the winner's attempt.
    if (!isUniqueViolation(error)) throw error
    const existing = await repo.findActiveAttempt(pool, auth.userId, scenarioId)
    if (!existing) throw error
    return { attempt: await snapshot(pool, existing), resumed: true }
  }
}

export async function getAttempt(auth: AuthContext, attemptId: string): Promise<PublicAttempt> {
  const pool = getPool()
  const attempt = await repo.getOwnedAttempt(pool, auth.userId, attemptId)
  if (!attempt) throw notFound()
  return snapshot(pool, attempt)
}

/** Loads an owned attempt with its pinned scenario. Server-internal: the scenario holds the answer key. */
export async function getOwnedAttemptWithScenario(
  auth: AuthContext,
  attemptId: string,
): Promise<{ attempt: repo.AttemptRow; scenario: ScenarioDefinition }> {
  const pool = getPool()
  const attempt = await repo.getOwnedAttempt(pool, auth.userId, attemptId)
  if (!attempt) throw notFound()
  return { attempt, scenario: await repo.getContentDefinition(pool, attempt.contentVersionId) }
}

/** Confidence history already on a diagnosis row; rows from before history was kept hold one value. */
function priorConfidence(event: repo.EventRow): { confidence: string; at: string }[] {
  const d = (event.detail ?? {}) as { confidence?: string; confidenceHistory?: { confidence: string; at: string }[] }
  if (Array.isArray(d.confidenceHistory)) return d.confidenceHistory
  return d.confidence ? [{ confidence: d.confidence, at: event.createdAt }] : []
}

async function applyEvent(
  q: Queryable,
  attempt: repo.AttemptRow,
  scenario: ScenarioDefinition,
  body: AttemptEventBody,
  source: 'guided' | 'voice',
): Promise<EventResult> {
  const result: EventResult = { recorded: [], duplicates: [], pendingConfirmation: [], reveals: [] }
  const submitted = attempt.status === 'submitted'

  if (body.type === 'lock_phase') {
    if (submitted) throw new ApiError('This attempt is already submitted.', 409, 'attempt_submitted')
    if (attempt.lockedPhases.includes(body.phase)) throw new ApiError(`The ${body.phase} phase is locked.`, 409, 'phase_locked')
    if (body.phase !== attempt.currentPhase) throw new ApiError('Only the current phase can be locked.', 409, 'wrong_phase')
    const lockedPhases = [...attempt.lockedPhases, body.phase]
    const next = phaseOrder[phaseOrder.indexOf(body.phase) + 1] ?? body.phase
    await repo.updateAttemptState(q, attempt.id, { currentPhase: next, lockedPhases })
    await repo.insertEvent(q, attempt.id, { type: 'phase_locked', phase: body.phase, source: 'system' })
    attempt.currentPhase = next
    attempt.lockedPhases = lockedPhases
    return result
  }

  if (body.type === 'retract') {
    if (submitted) throw new ApiError('This attempt is already submitted.', 409, 'attempt_submitted')
    if (attempt.lockedPhases.includes(body.phase)) throw new ApiError(`The ${body.phase} phase is locked.`, 409, 'phase_locked')
    const removed = await repo.retractActions(q, attempt.id, body.phase, [body.actionId])
    if (removed === 0) throw new ApiError('Event not found.', 404, 'event_not_found')
    return result
  }

  const plan = planTool(scenario, { ...attempt, submitted }, body.tool, {
    actionIds: body.actionIds,
    ...(body.confirmed === undefined ? {} : { confirmed: body.confirmed }),
  })
  if (plan.needsConfirmation) {
    result.pendingConfirmation = plan.actions.map((a) => a.id)
    return result
  }

  const live = await repo.listLiveEvents(q, attempt.id)
  if (body.tool === 'propose_diagnosis') {
    // One primary diagnosis: a newly confirmed choice replaces the previous one.
    const replaced = live
      .filter((e) => e.type === 'action' && e.phase === 'diagnosis' && e.actionId && !plan.actions.some((a) => a.id === e.actionId))
      .map((e) => e.actionId as string)
    if (replaced.length) await repo.retractActions(q, attempt.id, 'diagnosis', replaced)
  }
  // Diagnosis confidence (guided flow only) is stored with the confirmed diagnosis; skipping it records nothing.
  // The latest value drives grading; the history is kept so analytics can count changes of mind.
  const confidence = body.tool === 'propose_diagnosis' ? body.confidence : undefined
  const at = now().toISOString()
  const detail = confidence ? { confidence, confidenceHistory: [{ confidence, at }] } : undefined
  for (const action of plan.actions) {
    const existing = live.find((e) => e.type === 'action' && e.phase === plan.phase && e.actionId === action.id)
    if (existing) {
      if (confidence && plan.confirmed) {
        await repo.setActionDetail(q, attempt.id, plan.phase, action.id, { confidence, confidenceHistory: [...priorConfidence(existing), { confidence, at }] })
      }
      result.duplicates.push(action.id)
      continue
    }
    await repo.insertEvent(q, attempt.id, {
      type: 'action',
      phase: plan.phase,
      actionId: action.id,
      kind: plan.kind,
      confirmed: plan.confirmed,
      revealed: action.text,
      source,
      ...(detail ? { detail } : {}),
    })
    result.recorded.push(action.id)
    result.reveals.push({ id: action.id, text: action.text })
  }
  return result
}

/**
 * Applies one event under a row lock. A repeated idempotency key with the same body
 * returns the stored response; the same key with a different body is a conflict.
 */
export async function recordEvent(
  auth: AuthContext,
  attemptId: string,
  idempotencyKey: string,
  body: AttemptEventBody,
  source: 'guided' | 'voice',
): Promise<EventResponse> {
  const requestHash = sha256(canonicalJson({ source, body }))
  return withTransaction(getPool(), async (q) => {
    const attempt = await repo.getOwnedAttempt(q, auth.userId, attemptId, { forUpdate: true })
    if (!attempt) throw notFound()

    const prior = await repo.getIdempotentResponse(q, attempt.id, idempotencyKey)
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new ApiError('This Idempotency-Key was already used for a different request.', 409, 'idempotency_conflict')
      }
      return prior.response as EventResponse
    }

    const scenario = await repo.getContentDefinition(q, attempt.contentVersionId)
    const result = await applyEvent(q, attempt, scenario, body, source)
    const response: EventResponse = { result, attempt: await snapshot(q, attempt) }
    await repo.saveIdempotentResponse(q, attempt.id, idempotencyKey, requestHash, 200, response)
    return response
  })
}

export function selectionsOf(events: repo.EventRow[]): Record<PhaseId, string[]> {
  const out: Record<PhaseId, string[]> = { history: [], exam: [], diagnostics: [], diagnosis: [], treatment: [] }
  for (const e of events) {
    if (e.type !== 'action' || !e.actionId || !e.confirmed) continue
    if (!out[e.phase].includes(e.actionId)) out[e.phase].push(e.actionId)
  }
  return out
}

/** Grades once with the pinned content and current grading version; later calls return the stored result. */
export async function submitAttempt(auth: AuthContext, attemptId: string): Promise<PublicAttempt> {
  return withTransaction(getPool(), async (q) => {
    const attempt = await repo.getOwnedAttempt(q, auth.userId, attemptId, { forUpdate: true })
    if (!attempt) throw notFound()
    if (attempt.status === 'submitted') return snapshot(q, attempt)

    const events = await repo.listLiveEvents(q, attempt.id)
    const selectedByPhase = selectionsOf(events)
    if (selectedByPhase.diagnosis.length === 0) {
      throw new ApiError('Confirm a primary diagnosis before submitting.', 409, 'diagnosis_required')
    }

    const scenario = await repo.getContentDefinition(q, attempt.contentVersionId)
    const input: Attempt = {
      id: attempt.id,
      scenarioId: attempt.scenarioId,
      startedAt: attempt.createdAt,
      selectedByPhase,
      phaseLocks: phaseOrder,
      revealed: [],
      submitted: true,
    }
    const graded = gradeAttempt(scenario, input)

    await repo.ensureGradingVersion(q, GRADING_VERSION)
    await repo.insertResult(q, attempt.id, {
      gradingVersionId: GRADING_VERSION,
      contentVersionId: attempt.contentVersionId,
      inputDigest: sha256(canonicalJson({ grading: GRADING_VERSION, content: attempt.contentVersionId, selectedByPhase })),
      rawScore: graded.rawScore,
      finalScore: graded.finalScore,
      passed: graded.passed,
      criticalSafetyError: graded.criticalSafetyError,
      result: graded,
    })
    await repo.updateAttemptState(q, attempt.id, {
      currentPhase: attempt.currentPhase,
      lockedPhases: [...phaseOrder],
      status: 'submitted',
    })
    // Every graded miss gets a traceable remediation state in the same transaction.
    await deriveRemediationSafely(
      q,
      { attemptId: attempt.id, userId: auth.userId, scenarioId: attempt.scenarioId, scenario, selectedByPhase, confidence: confidenceOf(events) },
      now(),
    )
    const updated = await repo.getOwnedAttempt(q, auth.userId, attempt.id)
    return snapshot(q, updated!)
  })
}

interface Cursor {
  createdAt: string
  id: string
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>
    if (
      typeof parsed.createdAt === 'string' &&
      !Number.isNaN(Date.parse(parsed.createdAt)) &&
      typeof parsed.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id }
    }
  } catch {
    /* fall through */
  }
  throw new ApiError('Invalid history cursor.', 400, 'invalid_query')
}

export async function listHistory(auth: AuthContext, query: HistoryQuery): Promise<HistoryPage> {
  const rows = await repo.listHistory(getPool(), auth.userId, {
    limit: query.limit + 1,
    status: query.status,
    after: query.cursor ? decodeCursor(query.cursor) : undefined,
  })
  const page = rows.slice(0, query.limit)
  const last = page[page.length - 1]
  return {
    items: page.map(toAttemptSummary),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null,
  }
}

export async function recordLiveStarted(
  auth: AuthContext,
  attemptId: string,
  detail: { sessionId: string; promptVersion: string; liveModel: string; reasoningModel: string },
): Promise<void> {
  await withTransaction(getPool(), async (q) => {
    const attempt = await repo.getOwnedAttempt(q, auth.userId, attemptId, { forUpdate: true })
    if (!attempt) throw notFound()
    await repo.insertEvent(q, attempt.id, { type: 'live_started', phase: attempt.currentPhase, source: 'system', detail })
  })
}
