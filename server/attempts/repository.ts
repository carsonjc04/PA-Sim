// The only module that issues SQL for users, attempts, events and results.
import { randomUUID } from 'node:crypto'
import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'
import { upgradeStoredDefinition } from '../content/legacy'
import type { Queryable } from '../db/pool'
import { now } from '../lib/clock'

export interface UserRow {
  id: string
  displayName: string
}

export interface AttemptRow {
  id: string
  userId: string
  scenarioId: string
  contentVersionId: string
  status: 'active' | 'submitted'
  currentPhase: PhaseId
  lockedPhases: PhaseId[]
  createdAt: string
  submittedAt: string | null
}

export interface EventRow {
  seq: number
  type: 'action' | 'phase_locked' | 'live_started'
  phase: PhaseId
  actionId: string | null
  kind: string | null
  confirmed: boolean
  revealed: string | null
  source: 'guided' | 'voice' | 'system'
  /** Server-internal; never projected to the browser as-is. */
  detail: unknown
  createdAt: string
}

export interface ResultRow {
  gradingVersionId: string
  contentVersionId: string
  inputDigest: string
  result: unknown
  createdAt: string
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString()

export async function upsertUser(q: Queryable, provider: string, subject: string, displayName: string): Promise<UserRow> {
  const { rows } = await q.query<{ id: string; display_name: string }>(
    `INSERT INTO users (id, auth_provider, external_subject, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (auth_provider, external_subject) DO UPDATE SET display_name = users.display_name
     RETURNING id, display_name`,
    [randomUUID(), provider, subject, displayName],
  )
  return { id: rows[0].id, displayName: rows[0].display_name }
}

export async function ensureContentVersion(
  q: Queryable,
  version: { id: string; hash: string; semver: string; manifestVersion: string; scenario: ScenarioDefinition },
): Promise<void> {
  await q.query(
    `INSERT INTO content_versions (id, scenario_id, schema_version, content_hash, definition, content_semver, manifest_version, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [
      version.id,
      version.scenario.id,
      version.scenario.schemaVersion,
      version.hash,
      JSON.stringify(version.scenario),
      version.semver,
      version.manifestVersion,
      version.scenario.lifecycle.status,
    ],
  )
}

export async function getContentDefinition(q: Queryable, contentVersionId: string): Promise<ScenarioDefinition> {
  const { rows } = await q.query<{ definition: ScenarioDefinition }>(
    'SELECT definition FROM content_versions WHERE id = $1',
    [contentVersionId],
  )
  if (!rows[0]) throw new Error(`Content version ${contentVersionId} is missing`)
  return upgradeStoredDefinition(rows[0].definition)
}

export async function ensureGradingVersion(q: Queryable, id: string): Promise<void> {
  await q.query('INSERT INTO grading_versions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [id])
}

const attemptColumns = `id, user_id, scenario_id, content_version_id, status, current_phase, locked_phases, created_at, submitted_at`

function toAttempt(row: Record<string, unknown>): AttemptRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    scenarioId: row.scenario_id as string,
    contentVersionId: row.content_version_id as string,
    status: row.status as AttemptRow['status'],
    currentPhase: row.current_phase as PhaseId,
    lockedPhases: row.locked_phases as PhaseId[],
    createdAt: iso(row.created_at as Date)!,
    submittedAt: iso(row.submitted_at as Date | null),
  }
}

export async function findActiveAttempt(q: Queryable, userId: string, scenarioId: string): Promise<AttemptRow | null> {
  const { rows } = await q.query(
    `SELECT ${attemptColumns} FROM attempts WHERE user_id = $1 AND scenario_id = $2 AND status = 'active'`,
    [userId, scenarioId],
  )
  return rows[0] ? toAttempt(rows[0]) : null
}

export async function insertAttempt(
  q: Queryable,
  input: { userId: string; scenarioId: string; contentVersionId: string; firstPhase: PhaseId },
): Promise<AttemptRow> {
  const { rows } = await q.query(
    `INSERT INTO attempts (id, user_id, scenario_id, content_version_id, status, current_phase, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, $6, $6) RETURNING ${attemptColumns}`,
    [randomUUID(), input.userId, input.scenarioId, input.contentVersionId, input.firstPhase, now()],
  )
  return toAttempt(rows[0])
}

/** Ownership is part of the WHERE clause, so another user's attempt is indistinguishable from a missing one. */
export async function getOwnedAttempt(
  q: Queryable,
  userId: string,
  attemptId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AttemptRow | null> {
  const { rows } = await q.query(
    `SELECT ${attemptColumns} FROM attempts WHERE id = $1 AND user_id = $2${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [attemptId, userId],
  )
  return rows[0] ? toAttempt(rows[0]) : null
}

export async function updateAttemptState(
  q: Queryable,
  attemptId: string,
  state: { currentPhase: PhaseId; lockedPhases: PhaseId[]; status?: 'submitted' },
): Promise<void> {
  await q.query(
    `UPDATE attempts SET current_phase = $2, locked_phases = $3, updated_at = $5,
       status = COALESCE($4, status), submitted_at = CASE WHEN $4 = 'submitted' THEN $5 ELSE submitted_at END
     WHERE id = $1`,
    [attemptId, state.currentPhase, state.lockedPhases, state.status ?? null, now()],
  )
}

export async function listLiveEvents(q: Queryable, attemptId: string): Promise<EventRow[]> {
  const { rows } = await q.query(
    `SELECT seq, type, phase, action_id, kind, confirmed, revealed, source, detail, created_at
     FROM attempt_events WHERE attempt_id = $1 AND retracted_at IS NULL ORDER BY seq`,
    [attemptId],
  )
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    phase: row.phase,
    actionId: row.action_id,
    kind: row.kind,
    confirmed: row.confirmed ?? false,
    revealed: row.revealed,
    source: row.source,
    detail: row.detail ?? null,
    createdAt: iso(row.created_at)!,
  }))
}

export async function insertEvent(
  q: Queryable,
  attemptId: string,
  event: {
    type: EventRow['type']
    phase: PhaseId
    actionId?: string
    kind?: string
    confirmed?: boolean
    revealed?: string
    source: EventRow['source']
    detail?: unknown
  },
): Promise<void> {
  await q.query(
    `WITH next AS (UPDATE attempts SET next_seq = next_seq + 1, updated_at = $10 WHERE id = $1 RETURNING next_seq - 1 AS seq)
     INSERT INTO attempt_events (attempt_id, seq, type, phase, action_id, kind, confirmed, revealed, source, detail, created_at)
     SELECT $1, next.seq, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM next`,
    [
      attemptId,
      event.type,
      event.phase,
      event.actionId ?? null,
      event.kind ?? null,
      event.confirmed ?? null,
      event.revealed ?? null,
      event.source,
      event.detail === undefined ? null : JSON.stringify(event.detail),
      now(),
    ],
  )
}

/** Replaces the detail of a live action event (used to record diagnosis confidence on a re-confirmation). */
export async function setActionDetail(q: Queryable, attemptId: string, phase: PhaseId, actionId: string, detail: unknown): Promise<void> {
  await q.query(
    `UPDATE attempt_events SET detail = $4
     WHERE attempt_id = $1 AND phase = $2 AND action_id = $3 AND type = 'action' AND retracted_at IS NULL`,
    [attemptId, phase, actionId, detail === null ? null : JSON.stringify(detail)],
  )
}

export async function retractActions(q: Queryable, attemptId: string, phase: PhaseId, actionIds: string[]): Promise<number> {
  const { rowCount } = await q.query(
    `UPDATE attempt_events SET retracted_at = $4
     WHERE attempt_id = $1 AND phase = $2 AND action_id = ANY($3) AND type = 'action' AND retracted_at IS NULL`,
    [attemptId, phase, actionIds, now()],
  )
  return rowCount ?? 0
}

export async function getIdempotentResponse(
  q: Queryable,
  attemptId: string,
  key: string,
): Promise<{ requestHash: string; statusCode: number; response: unknown } | null> {
  const { rows } = await q.query(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE attempt_id = $1 AND key = $2',
    [attemptId, key],
  )
  return rows[0] ? { requestHash: rows[0].request_hash, statusCode: rows[0].status_code, response: rows[0].response } : null
}

export async function saveIdempotentResponse(
  q: Queryable,
  attemptId: string,
  key: string,
  requestHash: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await q.query(
    'INSERT INTO idempotency_keys (attempt_id, key, request_hash, status_code, response) VALUES ($1, $2, $3, $4, $5)',
    [attemptId, key, requestHash, statusCode, JSON.stringify(response)],
  )
}

export async function getResult(q: Queryable, attemptId: string): Promise<ResultRow | null> {
  const { rows } = await q.query(
    'SELECT grading_version_id, content_version_id, input_digest, result, created_at FROM attempt_results WHERE attempt_id = $1',
    [attemptId],
  )
  if (!rows[0]) return null
  return {
    gradingVersionId: rows[0].grading_version_id,
    contentVersionId: rows[0].content_version_id,
    inputDigest: rows[0].input_digest,
    result: rows[0].result,
    createdAt: iso(rows[0].created_at)!,
  }
}

export async function insertResult(
  q: Queryable,
  attemptId: string,
  input: {
    gradingVersionId: string
    contentVersionId: string
    inputDigest: string
    rawScore: number
    finalScore: number
    passed: boolean
    criticalSafetyError: boolean
    result: unknown
  },
): Promise<void> {
  await q.query(
    `INSERT INTO attempt_results
       (attempt_id, grading_version_id, content_version_id, input_digest, raw_score, final_score, passed, critical_safety_error, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      attemptId,
      input.gradingVersionId,
      input.contentVersionId,
      input.inputDigest,
      input.rawScore,
      input.finalScore,
      input.passed,
      input.criticalSafetyError,
      JSON.stringify(input.result),
    ],
  )
}

export interface HistoryRow {
  id: string
  scenarioId: string
  scenarioTitle: string
  status: 'active' | 'submitted'
  createdAt: string
  submittedAt: string | null
  finalScore: number | null
  passed: boolean | null
  /** Full-precision timestamp text; JS Dates drop microseconds and would break keyset paging. */
  cursorCreatedAt: string
}

export async function listHistory(
  q: Queryable,
  userId: string,
  options: { limit: number; status?: 'active' | 'submitted'; after?: { createdAt: string; id: string } },
): Promise<HistoryRow[]> {
  const params: unknown[] = [userId, options.limit]
  let where = 'a.user_id = $1'
  if (options.status) {
    params.push(options.status)
    where += ` AND a.status = $${params.length}`
  }
  if (options.after) {
    params.push(options.after.createdAt, options.after.id)
    where += ` AND (a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
  }
  const { rows } = await q.query(
    `SELECT a.id, a.scenario_id, a.status, a.created_at, a.created_at::text AS created_text, a.submitted_at,
            cv.definition -> 'summary' ->> 'title' AS title, r.final_score, r.passed
     FROM attempts a
     JOIN content_versions cv ON cv.id = a.content_version_id
     LEFT JOIN attempt_results r ON r.attempt_id = a.id
     WHERE ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $2`,
    params,
  )
  return rows.map((row) => ({
    id: row.id,
    scenarioId: row.scenario_id,
    scenarioTitle: row.title,
    status: row.status,
    createdAt: iso(row.created_at)!,
    submittedAt: iso(row.submitted_at),
    finalScore: row.final_score,
    passed: row.passed,
    cursorCreatedAt: row.created_text,
  }))
}
