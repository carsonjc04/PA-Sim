// Read-only loaders for learning analytics. Every query is scoped to one user and reads the stored event
// tables directly; analytics writes nothing and keeps no copy of its own.
import type { StoredAttempt, StoredDiagnosisEvent, StoredEvidence } from '../../src/domain/analytics/facts'
import type { RetentionFact } from '../../src/domain/analytics/types'
import type { Queryable } from '../db/pool'

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString())

export interface SubmittedAttemptRow extends StoredAttempt {
  /** False when the submit-time remediation derivation has not run (or failed); misses are then unknown. */
  derived: boolean
}

export async function listSubmittedAttempts(q: Queryable, userId: string): Promise<SubmittedAttemptRow[]> {
  const { rows } = await q.query(
    `SELECT a.id, a.scenario_id, a.content_version_id, a.created_at, a.submitted_at, r.critical_safety_error,
            d.remediation_version, d.attempt_id IS NOT NULL AS derived
     FROM attempts a
     JOIN attempt_results r ON r.attempt_id = a.id
     LEFT JOIN remediation_derivations d ON d.attempt_id = a.id
     WHERE a.user_id = $1 AND a.status = 'submitted'
     ORDER BY a.submitted_at, a.id`,
    [userId],
  )
  return rows.map((r) => ({
    id: r.id,
    scenarioId: r.scenario_id,
    contentVersionId: r.content_version_id,
    createdAt: iso(r.created_at)!,
    submittedAt: iso(r.submitted_at)!,
    criticalSafetyError: r.critical_safety_error,
    derivationVersion: r.remediation_version,
    derived: r.derived,
  }))
}

/** Every diagnosis action row of the user's submitted attempts, including retracted (replaced) ones. */
export async function listDiagnosisEvents(q: Queryable, userId: string): Promise<StoredDiagnosisEvent[]> {
  const { rows } = await q.query(
    `SELECT e.id::text AS id, e.attempt_id, e.seq, e.action_id, e.confirmed, e.retracted_at, e.detail, e.created_at
     FROM attempt_events e JOIN attempts a ON a.id = e.attempt_id
     WHERE a.user_id = $1 AND a.status = 'submitted' AND e.type = 'action' AND e.phase = 'diagnosis'
     ORDER BY e.attempt_id, e.seq`,
    [userId],
  )
  return rows.map((r) => ({
    id: r.id,
    attemptId: r.attempt_id,
    seq: r.seq,
    actionId: r.action_id,
    confirmed: r.confirmed ?? false,
    retractedAt: iso(r.retracted_at),
    detail: r.detail,
    createdAt: iso(r.created_at)!,
  }))
}

export async function listEvidence(q: Queryable, userId: string): Promise<StoredEvidence[]> {
  const { rows } = await q.query(
    `SELECT id, attempt_id, rubric_item_id, miss_kind, error_type, phase, label, kc_ids, created_at
     FROM remediation_evidence WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  )
  return rows.map((r) => ({
    id: r.id,
    attemptId: r.attempt_id,
    rubricItemId: r.rubric_item_id,
    kind: r.miss_kind,
    errorType: r.error_type,
    phase: r.phase,
    label: r.label,
    kcIds: r.kc_ids,
    createdAt: iso(r.created_at)!,
  }))
}

export async function listRetention(q: Queryable, userId: string): Promise<RetentionFact[]> {
  const { rows } = await q.query(
    `SELECT id::text AS id, card_id, recalled, retrievability, at
     FROM learning_events WHERE user_id = $1 AND type = 'retention' ORDER BY at, id`,
    [userId],
  )
  return rows.map((r) => ({ eventId: r.id, cardId: r.card_id, recalled: Boolean(r.recalled), retrievability: r.retrievability, at: iso(r.at)! }))
}
