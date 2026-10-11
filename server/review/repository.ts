// The only module that issues SQL for remediation evidence, review cards, sessions and learning events.
// Every timestamp is passed in from the application clock so scheduling is deterministic.
import { randomUUID } from 'node:crypto'
import type { DueReason, ErrorType, MissKind, PromptType, ReviewRating, ReviewState } from '../../src/domain/remediation/types'
import type { PhaseId } from '../../src/domain/types'
import type { Queryable } from '../db/pool'
import type { Scheduler } from './scheduler'

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString()

export interface CardRow {
  id: string
  userId: string
  kcId: string
  review: ReviewState
  algorithmVersion: string
  paramsId: string
  dueReason: DueReason
  lastPromptId: string | null
  createdAt: string
}

const cardColumns = `id, user_id, kc_id, fsrs_state, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses,
  last_review, algorithm_version, params_id, due_reason, last_prompt_id, created_at`

function toCard(row: Record<string, unknown>): CardRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    kcId: row.kc_id as string,
    review: {
      state: Number(row.fsrs_state) as ReviewState['state'],
      due: iso(row.due as Date)!,
      stability: Number(row.stability),
      difficulty: Number(row.difficulty),
      scheduledDays: Number(row.scheduled_days),
      learningSteps: Number(row.learning_steps),
      reps: Number(row.reps),
      lapses: Number(row.lapses),
      lastReview: iso(row.last_review as Date | null),
    },
    algorithmVersion: row.algorithm_version as string,
    paramsId: row.params_id as string,
    dueReason: row.due_reason as DueReason,
    lastPromptId: (row.last_prompt_id as string | null) ?? null,
    createdAt: iso(row.created_at as Date)!,
  }
}

export async function ensureSchedulerParams(q: Queryable, scheduler: Scheduler): Promise<void> {
  await q.query('INSERT INTO scheduler_params (id, algorithm_version, params) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [
    scheduler.paramsId,
    scheduler.algorithmVersion,
    JSON.stringify(scheduler.params),
  ])
}

export async function setUserTimeZone(q: Queryable, userId: string, timeZone: string): Promise<void> {
  await q.query('UPDATE users SET time_zone = $2 WHERE id = $1 AND time_zone IS DISTINCT FROM $2', [userId, timeZone])
}

// ---- Derivation ----

/** Claims an attempt for derivation. False when another request already derived it. */
export async function claimDerivation(q: Queryable, attemptId: string, at: Date, remediationVersion: string | null, missCount: number): Promise<boolean> {
  const { rowCount } = await q.query(
    `INSERT INTO remediation_derivations (attempt_id, derived_at, remediation_version, miss_count) VALUES ($1, $2, $3, $4)
     ON CONFLICT (attempt_id) DO NOTHING`,
    [attemptId, at, remediationVersion, missCount],
  )
  return (rowCount ?? 0) > 0
}

export interface UnderivedAttempt {
  id: string
  userId: string
  scenarioId: string
  contentVersionId: string
}

export async function listUnderivedAttempts(q: Queryable, userId: string): Promise<UnderivedAttempt[]> {
  const { rows } = await q.query(
    `SELECT a.id, a.user_id, a.scenario_id, a.content_version_id FROM attempts a
     LEFT JOIN remediation_derivations d ON d.attempt_id = a.id
     WHERE a.user_id = $1 AND a.status = 'submitted' AND d.attempt_id IS NULL
     ORDER BY a.submitted_at, a.id`,
    [userId],
  )
  return rows.map((r) => ({ id: r.id, userId: r.user_id, scenarioId: r.scenario_id, contentVersionId: r.content_version_id }))
}

export async function isDerived(q: Queryable, attemptId: string): Promise<boolean> {
  const { rowCount } = await q.query('SELECT 1 FROM remediation_derivations WHERE attempt_id = $1', [attemptId])
  return (rowCount ?? 0) > 0
}

export interface EvidenceInput {
  userId: string
  attemptId: string
  scenarioId: string
  rubricItemId: string
  kind: MissKind
  errorType: ErrorType
  phase: PhaseId
  label: string
  status: 'linked' | 'unmapped'
  kcIds: string[]
  remediationVersion: string | null
  at: Date
}

export async function insertEvidence(q: Queryable, e: EvidenceInput): Promise<string | null> {
  const { rows } = await q.query(
    `INSERT INTO remediation_evidence
       (id, user_id, attempt_id, scenario_id, rubric_item_id, miss_kind, error_type, phase, label, status, kc_ids, remediation_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (attempt_id, rubric_item_id) DO NOTHING RETURNING id`,
    [randomUUID(), e.userId, e.attemptId, e.scenarioId, e.rubricItemId, e.kind, e.errorType, e.phase, e.label, e.status, e.kcIds, e.remediationVersion, e.at],
  )
  return rows[0]?.id ?? null
}

/**
 * One card per user per knowledge component. A new card starts due now (reason new-miss). For an
 * existing card the memory state is untouched; the due date is pulled forward to `at` if later
 * (reason new-evidence).
 */
export async function upsertCard(
  q: Queryable,
  input: { userId: string; kcId: string; initial: ReviewState; scheduler: Scheduler; newMiss: DueReason; newEvidence: DueReason; at: Date },
): Promise<{ id: string; created: boolean }> {
  const s = input.initial
  const { rows } = await q.query(
    `INSERT INTO review_cards (id, user_id, kc_id, fsrs_state, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses,
       last_review, algorithm_version, params_id, due_reason, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
     ON CONFLICT (user_id, kc_id) DO UPDATE SET
       due = LEAST(review_cards.due, $16),
       due_reason = $17,
       updated_at = $16
     RETURNING id, (xmax = 0) AS created`,
    [
      randomUUID(), input.userId, input.kcId, s.state, s.due, s.stability, s.difficulty, s.scheduledDays, s.learningSteps, s.reps, s.lapses,
      s.lastReview, input.scheduler.algorithmVersion, input.scheduler.paramsId, JSON.stringify(input.newMiss), input.at, JSON.stringify(input.newEvidence),
    ],
  )
  return { id: rows[0].id, created: rows[0].created }
}

export async function linkEvidence(q: Queryable, evidenceId: string, cardId: string): Promise<void> {
  await q.query('INSERT INTO evidence_cards (evidence_id, card_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [evidenceId, cardId])
}

// ---- Cards ----

export async function listDueCards(q: Queryable, userId: string, before: Date): Promise<CardRow[]> {
  const { rows } = await q.query(`SELECT ${cardColumns} FROM review_cards WHERE user_id = $1 AND due < $2 ORDER BY due, id`, [userId, before])
  return rows.map(toCard)
}

export async function countCards(q: Queryable, userId: string): Promise<number> {
  const { rows } = await q.query('SELECT count(*)::int AS n FROM review_cards WHERE user_id = $1', [userId])
  return rows[0].n
}

export async function getCards(q: Queryable, userId: string, ids: string[]): Promise<CardRow[]> {
  const { rows } = await q.query(`SELECT ${cardColumns} FROM review_cards WHERE user_id = $1 AND id = ANY($2)`, [userId, ids])
  return rows.map(toCard)
}

export async function getOwnedCard(q: Queryable, userId: string, cardId: string, options: { forUpdate?: boolean } = {}): Promise<CardRow | null> {
  const { rows } = await q.query(`SELECT ${cardColumns} FROM review_cards WHERE id = $1 AND user_id = $2${options.forUpdate ? ' FOR UPDATE' : ''}`, [cardId, userId])
  return rows[0] ? toCard(rows[0]) : null
}

export async function listStaleCards(q: Queryable, scheduler: Scheduler, userId?: string): Promise<CardRow[]> {
  const params: unknown[] = [scheduler.algorithmVersion, scheduler.paramsId]
  let where = '(algorithm_version <> $1 OR params_id <> $2)'
  if (userId) {
    params.push(userId)
    where += ' AND user_id = $3'
  }
  const { rows } = await q.query(`SELECT ${cardColumns} FROM review_cards WHERE ${where} ORDER BY id FOR UPDATE`, params)
  return rows.map(toCard)
}

export async function updateCard(
  q: Queryable,
  cardId: string,
  input: { review: ReviewState; scheduler: Scheduler; dueReason?: DueReason; lastPromptId?: string; at: Date },
): Promise<void> {
  const s = input.review
  await q.query(
    `UPDATE review_cards SET fsrs_state = $2, due = $3, stability = $4, difficulty = $5, scheduled_days = $6, learning_steps = $7,
       reps = $8, lapses = $9, last_review = $10, algorithm_version = $11, params_id = $12,
       due_reason = COALESCE($13, due_reason), last_prompt_id = COALESCE($14, last_prompt_id), updated_at = $15
     WHERE id = $1`,
    [
      cardId, s.state, s.due, s.stability, s.difficulty, s.scheduledDays, s.learningSteps, s.reps, s.lapses, s.lastReview,
      input.scheduler.algorithmVersion, input.scheduler.paramsId, input.dueReason ? JSON.stringify(input.dueReason) : null, input.lastPromptId ?? null, input.at,
    ],
  )
}

export async function listCardReviews(q: Queryable, cardId: string): Promise<{ rating: ReviewRating; reviewedAt: string; promptId: string }[]> {
  const { rows } = await q.query('SELECT rating, reviewed_at, prompt_id FROM review_events WHERE card_id = $1 ORDER BY reviewed_at, id', [cardId])
  return rows.map((r) => ({ rating: r.rating as ReviewRating, reviewedAt: iso(r.reviewed_at)!, promptId: r.prompt_id }))
}

export async function listCardEvidenceTimes(q: Queryable, cardId: string): Promise<string[]> {
  const { rows } = await q.query(
    'SELECT e.created_at FROM remediation_evidence e JOIN evidence_cards ec ON ec.evidence_id = e.id WHERE ec.card_id = $1 ORDER BY e.created_at',
    [cardId],
  )
  return rows.map((r) => iso(r.created_at)!)
}

export interface CardSource {
  cardId: string
  attemptId: string
  scenarioId: string
  scenarioTitle: string
  rubricItemId: string
  label: string
  at: string
}

/** The most recent graded miss behind each card: where "jump back to the case" leads. */
export async function latestSources(q: Queryable, cardIds: string[]): Promise<Map<string, CardSource>> {
  if (cardIds.length === 0) return new Map()
  const { rows } = await q.query(
    `SELECT DISTINCT ON (ec.card_id) ec.card_id, e.attempt_id, e.scenario_id, e.rubric_item_id, e.label, e.created_at,
            cv.definition -> 'summary' ->> 'title' AS title
     FROM evidence_cards ec
     JOIN remediation_evidence e ON e.id = ec.evidence_id
     JOIN attempts a ON a.id = e.attempt_id
     JOIN content_versions cv ON cv.id = a.content_version_id
     WHERE ec.card_id = ANY($1)
     ORDER BY ec.card_id, e.created_at DESC, e.id`,
    [cardIds],
  )
  return new Map(
    rows.map((r) => [
      r.card_id,
      { cardId: r.card_id, attemptId: r.attempt_id, scenarioId: r.scenario_id, scenarioTitle: r.title, rubricItemId: r.rubric_item_id, label: r.label, at: iso(r.created_at)! },
    ]),
  )
}

/** Scenarios the user has submitted at least once. Prompts are drawn only from these, so nothing leaks from unplayed cases. */
export async function submittedScenarioIds(q: Queryable, userId: string): Promise<Set<string>> {
  const { rows } = await q.query(`SELECT DISTINCT scenario_id FROM attempts WHERE user_id = $1 AND status = 'submitted'`, [userId])
  return new Set(rows.map((r) => r.scenario_id as string))
}

export interface EvidenceRow {
  id: string
  rubricItemId: string
  kind: MissKind
  errorType: ErrorType
  label: string
  status: 'linked' | 'unmapped'
  remediationVersion: string | null
  cards: { cardId: string; kcId: string; due: string }[]
}

export async function listAttemptEvidence(q: Queryable, attemptId: string): Promise<EvidenceRow[]> {
  const { rows } = await q.query(
    `SELECT e.id, e.rubric_item_id, e.miss_kind, e.error_type, e.label, e.status, e.remediation_version,
            COALESCE(json_agg(json_build_object('cardId', c.id, 'kcId', c.kc_id, 'due', c.due) ORDER BY c.kc_id) FILTER (WHERE c.id IS NOT NULL), '[]') AS cards
     FROM remediation_evidence e
     LEFT JOIN evidence_cards ec ON ec.evidence_id = e.id
     LEFT JOIN review_cards c ON c.id = ec.card_id
     WHERE e.attempt_id = $1
     GROUP BY e.id
     ORDER BY e.created_at, e.rubric_item_id`,
    [attemptId],
  )
  return rows.map((r) => ({
    id: r.id,
    rubricItemId: r.rubric_item_id,
    kind: r.miss_kind,
    errorType: r.error_type,
    label: r.label,
    status: r.status,
    remediationVersion: r.remediation_version,
    cards: (r.cards as { cardId: string; kcId: string; due: string }[]).map((c) => ({ ...c, due: iso(c.due)! })),
  }))
}

// ---- Sessions ----

export interface SessionRow {
  id: string
  userId: string
  localDay: string
  timeZone: string
  mode: 'all' | 'micro'
  cardIds: string[]
  promptIds: string[]
  position: number
  createdAt: string
  closedAt: string | null
}

const sessionColumns = 'id, user_id, local_day::text AS local_day, time_zone, mode, card_ids, prompt_ids, position, created_at, closed_at'
function toSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    localDay: r.local_day as string,
    timeZone: r.time_zone as string,
    mode: r.mode as SessionRow['mode'],
    cardIds: r.card_ids as string[],
    promptIds: r.prompt_ids as string[],
    position: Number(r.position),
    createdAt: iso(r.created_at as Date)!,
    closedAt: iso(r.closed_at as Date | null),
  }
}

export async function getOpenSession(q: Queryable, userId: string, options: { forUpdate?: boolean } = {}): Promise<SessionRow | null> {
  const { rows } = await q.query(`SELECT ${sessionColumns} FROM review_sessions WHERE user_id = $1 AND closed_at IS NULL${options.forUpdate ? ' FOR UPDATE' : ''}`, [userId])
  return rows[0] ? toSession(rows[0]) : null
}

export async function getOwnedSession(q: Queryable, userId: string, sessionId: string, options: { forUpdate?: boolean } = {}): Promise<SessionRow | null> {
  const { rows } = await q.query(`SELECT ${sessionColumns} FROM review_sessions WHERE id = $1 AND user_id = $2${options.forUpdate ? ' FOR UPDATE' : ''}`, [sessionId, userId])
  return rows[0] ? toSession(rows[0]) : null
}

export async function insertSession(
  q: Queryable,
  input: { userId: string; localDay: string; timeZone: string; mode: 'all' | 'micro'; cardIds: string[]; promptIds: string[]; at: Date },
): Promise<SessionRow> {
  const { rows } = await q.query(
    `INSERT INTO review_sessions (id, user_id, local_day, time_zone, mode, card_ids, prompt_ids, position, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) RETURNING ${sessionColumns}`,
    [randomUUID(), input.userId, input.localDay, input.timeZone, input.mode, input.cardIds, input.promptIds, input.at],
  )
  return toSession(rows[0])
}

export async function closeSession(q: Queryable, sessionId: string, reason: 'finished' | 'expired' | 'restarted', at: Date): Promise<void> {
  await q.query('UPDATE review_sessions SET closed_at = $2, closed_reason = $3 WHERE id = $1 AND closed_at IS NULL', [sessionId, at, reason])
}

export async function advanceSession(q: Queryable, sessionId: string, position: number): Promise<void> {
  await q.query('UPDATE review_sessions SET position = $2 WHERE id = $1', [sessionId, position])
}

// ---- Reviews ----

export async function getReviewByKey(q: Queryable, userId: string, key: string): Promise<{ requestHash: string; response: unknown } | null> {
  const { rows } = await q.query('SELECT request_hash, response FROM review_events WHERE user_id = $1 AND idempotency_key = $2', [userId, key])
  return rows[0] ? { requestHash: rows[0].request_hash, response: rows[0].response } : null
}

export async function insertReview(
  q: Queryable,
  input: {
    userId: string
    cardId: string
    sessionId: string
    promptId: string
    promptType: PromptType
    rating: ReviewRating
    latencyMs: number | null
    at: Date
    before: ReviewState
    after: ReviewState
    scheduler: Scheduler
    key: string
    requestHash: string
    response: unknown
  },
): Promise<void> {
  await q.query(
    `INSERT INTO review_events (id, user_id, card_id, session_id, prompt_id, prompt_type, rating, latency_ms, reviewed_at,
       state_before, state_after, algorithm_version, params_id, idempotency_key, request_hash, response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      randomUUID(), input.userId, input.cardId, input.sessionId, input.promptId, input.promptType, input.rating, input.latencyMs, input.at,
      JSON.stringify(input.before), JSON.stringify(input.after), input.scheduler.algorithmVersion, input.scheduler.paramsId, input.key, input.requestHash,
      JSON.stringify(input.response),
    ],
  )
}

// ---- Instrumentation ----

export interface LearningEvent {
  userId: string
  type: 'due' | 'shown' | 'answered' | 'rated' | 'retention'
  cardId: string
  sessionId: string | null
  promptType?: PromptType | null
  rating?: number | null
  latencyMs?: number | null
  elapsedDays?: number | null
  retrievability?: number | null
  recalled?: boolean | null
  at: Date
}

/** At most one event of each type per card per session, so retries and refreshes do not double count. */
export async function insertLearningEvent(q: Queryable, e: LearningEvent): Promise<void> {
  await q.query(
    `INSERT INTO learning_events (user_id, type, card_id, session_id, prompt_type, rating, latency_ms, elapsed_days, retrievability, recalled, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
    [e.userId, e.type, e.cardId, e.sessionId, e.promptType ?? null, e.rating ?? null, e.latencyMs ?? null, e.elapsedDays ?? null, e.retrievability ?? null, e.recalled ?? null, e.at],
  )
}
