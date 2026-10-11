import type { AnnotationMark, AnnotationTargetKind, PublicAnnotation, PublicNotes, SaveNotesBody, SetAnnotationBody } from '../../src/api/contracts'
import { annotationMarks } from '../../src/api/contracts'
import type { ScenarioDefinition } from '../../src/domain/types'
import * as attempts from '../attempts/repository'
import type { AuthContext } from '../auth/context'
import { getPool, withTransaction, type Queryable } from '../db/pool'
import { ApiError } from '../http/errors'
import { now } from '../lib/clock'

// Notes are learner free text. They are read and written only here, only by the attempt's owner, and are
// never logged, copied into other tables, sent to the voice model or embedded in attempt or debrief payloads.

const notFound = () => new ApiError('Attempt not found.', 404, 'attempt_not_found')

async function owned(q: Queryable, auth: AuthContext, attemptId: string, forUpdate = false) {
  const attempt = await attempts.getOwnedAttempt(q, auth.userId, attemptId, { forUpdate })
  if (!attempt) throw notFound()
  return attempt
}

const toNotes = (row?: { body: string; version: number; updated_at: Date }): PublicNotes =>
  row ? { body: row.body, version: row.version, updatedAt: row.updated_at.toISOString() } : { body: '', version: 0, updatedAt: null }

export async function getNotes(auth: AuthContext, attemptId: string): Promise<PublicNotes> {
  const q = getPool()
  await owned(q, auth, attemptId)
  const { rows } = await q.query('SELECT body, version, updated_at FROM attempt_notes WHERE attempt_id = $1', [attemptId])
  return toNotes(rows[0])
}

/** Optimistic concurrency: the client sends the version it edited; a stale version is a conflict, never an overwrite. */
export async function saveNotes(auth: AuthContext, attemptId: string, body: SaveNotesBody): Promise<PublicNotes> {
  return withTransaction(getPool(), async (q) => {
    await owned(q, auth, attemptId, true)
    const { rows } = await q.query('SELECT body, version, updated_at FROM attempt_notes WHERE attempt_id = $1', [attemptId])
    const current = toNotes(rows[0])
    if (current.version !== body.version) {
      throw new ApiError('These notes were changed somewhere else. Choose which version to keep.', 409, 'notes_conflict', { current })
    }
    if (current.body === body.body) return current
    const at = now()
    const saved = await q.query(
      `INSERT INTO attempt_notes (attempt_id, user_id, body, version, updated_at) VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (attempt_id) DO UPDATE SET body = EXCLUDED.body, version = attempt_notes.version + 1, updated_at = EXCLUDED.updated_at
       RETURNING body, version, updated_at`,
      [attemptId, auth.userId, body.body, at],
    )
    return toNotes(saved.rows[0])
  })
}

function targetExists(s: ScenarioDefinition, kind: AnnotationTargetKind, id: string): boolean {
  if (kind === 'diagnosis') return s.diagnoses.some((d) => d.id === id)
  if (kind === 'plan') return s.planOptions.some((p) => p.id === id)
  return s.phases.some((p) => p.actions.some((a) => a.id === id))
}

async function listFor(q: Queryable, attemptId: string): Promise<PublicAnnotation[]> {
  const { rows } = await q.query<{ target_kind: AnnotationTargetKind; target_id: string; mark: AnnotationMark }>(
    'SELECT target_kind, target_id, mark FROM attempt_annotations WHERE attempt_id = $1 ORDER BY target_kind, target_id, mark',
    [attemptId],
  )
  const out = new Map<string, PublicAnnotation>()
  for (const r of rows) {
    const key = `${r.target_kind}:${r.target_id}`
    const entry = out.get(key) ?? { targetKind: r.target_kind, targetId: r.target_id, marks: [] }
    entry.marks.push(r.mark)
    out.set(key, entry)
  }
  for (const a of out.values()) a.marks.sort((x, y) => annotationMarks.indexOf(x) - annotationMarks.indexOf(y))
  return [...out.values()]
}

export async function listAnnotations(auth: AuthContext, attemptId: string): Promise<PublicAnnotation[]> {
  const q = getPool()
  await owned(q, auth, attemptId)
  return listFor(q, attemptId)
}

/** Replaces the marks on one target. Targets must exist in the attempt's pinned case version. */
export async function setAnnotation(auth: AuthContext, attemptId: string, body: SetAnnotationBody): Promise<PublicAnnotation[]> {
  return withTransaction(getPool(), async (q) => {
    const attempt = await owned(q, auth, attemptId, true)
    const scenario = await attempts.getContentDefinition(q, attempt.contentVersionId)
    if (!targetExists(scenario, body.targetKind, body.targetId)) throw new ApiError('That item is not part of this case.', 404, 'annotation_target_not_found')
    await q.query('DELETE FROM attempt_annotations WHERE attempt_id = $1 AND target_kind = $2 AND target_id = $3', [attemptId, body.targetKind, body.targetId])
    for (const mark of new Set(body.marks)) {
      await q.query('INSERT INTO attempt_annotations (attempt_id, target_kind, target_id, mark) VALUES ($1, $2, $3, $4)', [attemptId, body.targetKind, body.targetId, mark])
    }
    return listFor(q, attemptId)
  })
}
