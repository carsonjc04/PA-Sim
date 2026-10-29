import { createHash } from 'node:crypto'
import { env } from '../config/env'
import { getPool, type Queryable } from '../db/pool'
import { ApiError } from '../http/errors'
import { now } from '../lib/clock'

/**
 * The server's record of every billed voice session it minted (table live_sessions).
 *
 * The encounter's time budget is MAX_LIVE_SESSION_MINUTES of session time per attempt, summed across
 * reconnects, so a client cannot reset the clock by reconnecting. Everything here reads the server clock
 * and the ledger; nothing trusts the browser's timer.
 */

export type EndReason = 'limit' | 'replaced' | 'idle' | 'client_end' | 'assumed_expired'

export interface LedgerSession {
  sessionId: string
  attemptId: string
  userId: string
  clientKey: string
  startedAt: Date
  deadlineAt: Date
  lastActivityAt: Date
  flaggedAt: Date | null
  endedAt: Date | null
  endReason: EndReason | null
}

/** After the deadline the provider has ended the session on its own side well before this; stop blocking then. */
export const ASSUME_ENDED_AFTER_MS = 60 * 60_000

export const budgetMs = () => env.MAX_LIVE_SESSION_MINUTES * 60_000
export const idleMs = () => env.LIVE_IDLE_TIMEOUT_SECONDS * 1000

/** One-way key for an address: enough to match repeat mints, never stored raw. */
export function clientKeyOf(ip: string | undefined): string {
  return createHash('sha256').update(ip ?? 'unknown').digest('hex')
}

interface Row {
  session_id: string
  attempt_id: string
  user_id: string
  client_key: string
  started_at: Date
  deadline_at: Date
  last_activity_at: Date
  flagged_at: Date | null
  ended_at: Date | null
  end_reason: EndReason | null
}

const toSession = (r: Row): LedgerSession => ({
  sessionId: r.session_id,
  attemptId: r.attempt_id,
  userId: r.user_id,
  clientKey: r.client_key,
  startedAt: r.started_at,
  deadlineAt: r.deadline_at,
  lastActivityAt: r.last_activity_at,
  flaggedAt: r.flagged_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
})

/** Session time this attempt has already used. An unclosed session counts up to now (errs toward spending). */
export async function usedBudgetMs(attemptId: string): Promise<number> {
  const { rows } = await getPool().query<{ used: string | null }>(
    `SELECT sum(extract(epoch FROM (least(coalesce(ended_at, $2), deadline_at) - started_at)) * 1000) AS used
     FROM live_sessions WHERE attempt_id = $1`,
    [attemptId, now()],
  )
  return Math.max(0, Number(rows[0]?.used ?? 0))
}

// Mints in flight (between the check and the insert) count toward the limits, so a burst of parallel
// requests cannot all pass the check before any row exists. The server runs as one process.
const minting = new Map<string, number>()
const bump = (key: string, by: number) => minting.set(key, (minting.get(key) ?? 0) + by)
const pending = (key: string) => minting.get(key) ?? 0
// Check-and-reserve runs one at a time; otherwise parallel requests all read the counts before any reserves.
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/**
 * Refuses a new session when: this attempt's budget is spent; this user or address has a session the
 * server flagged as running past its cap and has not yet confirmed closed; or the address or the whole
 * server is at its open-session limit. The user's own open sessions do not count: starting a new one
 * replaces them. Returns the attempt's remaining budget and a release function for the in-flight reservation.
 */
export function reserveMint(input: { userId: string; clientKey: string; attemptId: string }): Promise<{ remainingMs: number; release: () => void }> {
  return serialized(() => checkAndReserve(input))
}

async function checkAndReserve(input: { userId: string; clientKey: string; attemptId: string }): Promise<{ remainingMs: number; release: () => void }> {
  const remaining = budgetMs() - (await usedBudgetMs(input.attemptId))
  if (remaining < 30_000) {
    throw new ApiError(
      `This encounter has used its ${env.MAX_LIVE_SESSION_MINUTES} minutes of voice time. Continue with the case below.`,
      409,
      'live_budget_spent',
    )
  }

  const { rows } = await getPool().query<{ unresolved: number; open_all: number; open_client: number }>(
    `SELECT
       count(*) FILTER (WHERE flagged_at IS NOT NULL AND (user_id = $1 OR client_key = $2))::int AS unresolved,
       count(*) FILTER (WHERE user_id <> $1)::int AS open_all,
       count(*) FILTER (WHERE user_id <> $1 AND client_key = $2)::int AS open_client
     FROM live_sessions WHERE ended_at IS NULL`,
    [input.userId, input.clientKey],
  )
  const counts = rows[0]
  if (counts.unresolved > 0) {
    throw new ApiError(
      'A previous voice session ran past its time limit and has not been confirmed closed yet. Try again in a minute.',
      409,
      'live_session_unresolved',
    )
  }
  if (counts.open_client + pending(`c:${input.clientKey}`) >= env.LIVE_MAX_SESSIONS_PER_CLIENT) {
    throw new ApiError('Too many voice sessions are open from this connection. End one first.', 429, 'live_client_limit')
  }
  if (counts.open_all + pending('all') >= env.LIVE_MAX_CONCURRENT_SESSIONS) {
    throw new ApiError('Voice is at capacity right now. Try again shortly, or continue without voice.', 503, 'live_capacity')
  }

  const keys = ['all', `c:${input.clientKey}`]
  for (const k of keys) bump(k, 1)
  let released = false
  return {
    remainingMs: Math.min(remaining, budgetMs()),
    release: () => {
      if (released) return
      released = true
      for (const k of keys) bump(k, -1)
    },
  }
}

/** Records a minted session; its deadline is now plus the attempt's remaining budget. Returns the deadline. */
export async function recordMint(s: { sessionId: string; attemptId: string; userId: string; clientKey: string; remainingMs: number }): Promise<Date> {
  const at = now()
  const deadline = new Date(at.getTime() + s.remainingMs)
  await getPool().query(
    `INSERT INTO live_sessions (session_id, attempt_id, user_id, client_key, started_at, deadline_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    [s.sessionId, s.attemptId, s.userId, s.clientKey, at, deadline],
  )
  return deadline
}

export async function getSession(sessionId: string): Promise<LedgerSession | null> {
  const { rows } = await getPool().query<Row>('SELECT * FROM live_sessions WHERE session_id = $1', [sessionId])
  return rows[0] ? toSession(rows[0]) : null
}

export async function openSessions(): Promise<LedgerSession[]> {
  const { rows } = await getPool().query<Row>('SELECT * FROM live_sessions WHERE ended_at IS NULL')
  return rows.map(toSession)
}

/** Open sessions belonging to this user, other than `except`. */
export async function otherOpenSessionsOf(userId: string, except: string): Promise<LedgerSession[]> {
  const { rows } = await getPool().query<Row>(
    'SELECT * FROM live_sessions WHERE ended_at IS NULL AND user_id = $1 AND session_id <> $2',
    [userId, except],
  )
  return rows.map(toSession)
}

export async function markEnded(sessionId: string, reason: EndReason): Promise<void> {
  await getPool().query('UPDATE live_sessions SET ended_at = $2, end_reason = $3 WHERE session_id = $1 AND ended_at IS NULL', [sessionId, now(), reason])
}

export async function flag(sessionId: string): Promise<void> {
  await getPool().query('UPDATE live_sessions SET flagged_at = $2 WHERE session_id = $1 AND flagged_at IS NULL AND ended_at IS NULL', [sessionId, now()])
}

/** Student activity keeps a session from being ended as idle. Ignored once the session is over. */
export async function touch(sessionId: string, attemptId: string): Promise<boolean> {
  const at = now()
  const { rowCount } = await getPool().query(
    'UPDATE live_sessions SET last_activity_at = $3 WHERE session_id = $1 AND attempt_id = $2 AND ended_at IS NULL AND deadline_at > $3',
    [sessionId, attemptId, at],
  )
  return (rowCount ?? 0) > 0
}

export type SessionVerdict =
  | { ok: true; session: LedgerSession }
  | { ok: false; code: 'live_session_required' | 'live_session_ended' | 'live_session_expired' | 'live_session_idle'; session: LedgerSession | null }

/** Whether a session may still be served right now, by the server clock. */
export function judge(session: LedgerSession | null, at = now()): SessionVerdict {
  if (!session) return { ok: false, code: 'live_session_required', session }
  if (session.endedAt) return { ok: false, code: 'live_session_ended', session }
  if (at.getTime() >= session.deadlineAt.getTime()) return { ok: false, code: 'live_session_expired', session }
  if (at.getTime() - session.lastActivityAt.getTime() > idleMs()) return { ok: false, code: 'live_session_idle', session }
  return { ok: true, session }
}

// ---- Avatar layer (one per voice session at most) ----

export type AvatarEndReason = 'client_end' | 'failed' | 'voice_ended' | 'limit'

export interface LedgerAvatar {
  sessionId: string
  attemptId: string
  avatarSessionId: string | null
  startedAt: Date
  deadlineAt: Date | null
  endedAt: Date | null
}

/**
 * Claims the voice session's one avatar slot. False when it was already claimed (an avatar is chosen before the
 * session, never added again later), so parallel requests can never start two billed avatars.
 */
export async function claimAvatar(sessionId: string, attemptId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'UPDATE live_sessions SET avatar_started_at = $3 WHERE session_id = $1 AND attempt_id = $2 AND avatar_started_at IS NULL AND ended_at IS NULL',
    [sessionId, attemptId, now()],
  )
  return (rowCount ?? 0) > 0
}

/** Records the started avatar; its minutes count from now. */
export async function recordAvatarStart(sessionId: string, avatarSessionId: string, deadline: Date): Promise<void> {
  await getPool().query('UPDATE live_sessions SET avatar_session_id = $2, avatar_started_at = $3, avatar_deadline_at = $4 WHERE session_id = $1', [sessionId, avatarSessionId, now(), deadline])
}

/** Ends the avatar on the ledger. A claim the provider never started ends with zero minutes. */
export async function markAvatarEnded(sessionId: string, reason: AvatarEndReason): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE live_sessions SET avatar_ended_at = CASE WHEN avatar_session_id IS NULL THEN avatar_started_at ELSE least($2, coalesce(avatar_deadline_at, $2)) END,
       avatar_end_reason = $3
     WHERE session_id = $1 AND avatar_started_at IS NOT NULL AND avatar_ended_at IS NULL`,
    [sessionId, now(), reason],
  )
  return (rowCount ?? 0) > 0
}

export async function setAvatarCredits(sessionId: string, credits: number): Promise<void> {
  await getPool().query('UPDATE live_sessions SET avatar_credits = $2 WHERE session_id = $1', [sessionId, credits])
}

const toAvatar = (r: { session_id: string; attempt_id: string; avatar_session_id: string | null; avatar_started_at: Date; avatar_deadline_at: Date | null; avatar_ended_at: Date | null }): LedgerAvatar => ({
  sessionId: r.session_id,
  attemptId: r.attempt_id,
  avatarSessionId: r.avatar_session_id,
  startedAt: r.avatar_started_at,
  deadlineAt: r.avatar_deadline_at,
  endedAt: r.avatar_ended_at,
})

export async function getAvatar(sessionId: string): Promise<LedgerAvatar | null> {
  const { rows } = await getPool().query('SELECT * FROM live_sessions WHERE session_id = $1 AND avatar_started_at IS NOT NULL', [sessionId])
  return rows[0] ? toAvatar(rows[0]) : null
}

/** Avatars still open on the ledger, with whether their voice session has ended. */
export async function openAvatars(): Promise<(LedgerAvatar & { voiceEnded: boolean })[]> {
  const { rows } = await getPool().query('SELECT * FROM live_sessions WHERE avatar_started_at IS NOT NULL AND avatar_ended_at IS NULL')
  return rows.map((r) => ({ ...toAvatar(r), voiceEnded: r.ended_at !== null }))
}

/** Billed time on this attempt: voice and avatar, summed across sessions. Open ones count up to now. */
export async function usageOf(attemptId: string, q: Queryable = getPool()): Promise<{ sessions: number; voiceMs: number; avatarMs: number; avatarCredits: number | null; avatarSessions: number }> {
  const { rows } = await q.query<{ sessions: number; voice: string | null; avatar: string | null; credits: string | null; avatars: number; unreported: number }>(
    `SELECT count(*)::int AS sessions,
       sum(extract(epoch FROM (least(coalesce(ended_at, $2), deadline_at) - started_at)) * 1000) AS voice,
       sum(extract(epoch FROM (least(coalesce(avatar_ended_at, $2), coalesce(avatar_deadline_at, $2)) - avatar_started_at)) * 1000)
         FILTER (WHERE avatar_session_id IS NOT NULL) AS avatar,
       sum(avatar_credits) AS credits,
       count(*) FILTER (WHERE avatar_session_id IS NOT NULL)::int AS avatars,
       count(*) FILTER (WHERE avatar_session_id IS NOT NULL AND avatar_credits IS NULL)::int AS unreported
     FROM live_sessions WHERE attempt_id = $1`,
    [attemptId, now()],
  )
  const r = rows[0]
  return {
    sessions: r.sessions,
    voiceMs: Math.max(0, Number(r.voice ?? 0)),
    avatarMs: Math.max(0, Number(r.avatar ?? 0)),
    // Only a full report is a reported total; a partial one would understate.
    avatarCredits: r.avatars > 0 && r.unreported === 0 ? Number(r.credits) : null,
    avatarSessions: r.avatars,
  }
}

/** Test seam. */
export function resetLedgerReservations(): void {
  minting.clear()
}
