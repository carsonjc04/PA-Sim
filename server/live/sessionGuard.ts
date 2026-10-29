import { SidebandWS } from 'openai/resources/live/sideband/ws'
import { endAvatar, sweepAvatars } from '../avatar/guard'
import { env } from '../config/env'
import { now } from '../lib/clock'
import { openaiClient } from '../openai/client'
import * as ledger from './ledger'

/**
 * Server-side kill switch for billed Live voice sessions.
 *
 * The browser talks to OpenAI directly over WebRTC, so nothing the browser does can be trusted to end a
 * session. The server minted the session and records it in the ledger (live_sessions), so it also ends it:
 * - at creation it schedules a close at the deadline (the attempt's remaining voice budget);
 * - a sweeper runs every LIVE_SWEEP_INTERVAL_MS: sessions open past their deadline are flagged and closed,
 *   sessions with no student activity for LIVE_IDLE_TIMEOUT_SECONDS are closed (abandoned tabs);
 * - every tool relay checks the ledger and refuses calls for a session that is over (the leash);
 * - starting a session closes the same user's other open sessions, so one user never has two meters running;
 * - a flagged session blocks new sessions for that user and address until its close is confirmed.
 *
 * Closing uses a trusted sideband connection to the session and sends `session.close`. A close is recorded in
 * the ledger only when confirmed; otherwise the sweeper retries it.
 */

export interface SessionCloser {
  /** Resolves true when the provider confirmed the close (or the session no longer exists), false if unconfirmed. */
  close(sessionId: string): Promise<boolean | void>
}

const CLOSE_TIMEOUT_MS = 5_000

/** A session the provider no longer knows about is already closed. */
function isGone(error: unknown): boolean {
  const e = error as { status?: number; code?: string; error?: { code?: string } } | undefined
  return e?.status === 404 || e?.code === 'session_not_found' || e?.error?.code === 'session_not_found'
}

/** Attaches a sideband WebSocket to the session, asks it to close, and waits for the close (bounded). */
export const sidebandCloser: SessionCloser = {
  close(sessionId) {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false
      const ws = new SidebandWS(openaiClient(), { session_id: sessionId })
      const finish = (error?: unknown, confirmed = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* already closed */
        }
        if (error && !isGone(error)) reject(error instanceof Error ? error : new Error('sideband close failed'))
        else resolve(confirmed || Boolean(error))
      }
      const timer = setTimeout(() => finish(), CLOSE_TIMEOUT_MS)
      ws.on('session.closed', () => finish(undefined, true))
      ws.on('error', (e: unknown) => finish(e))
      // Queued until the socket opens.
      ws.send({ type: 'session.close' })
    })
  },
}

let closer: SessionCloser = sidebandCloser
/** Test seam. */
export function setSessionCloser(next: SessionCloser | null): void {
  closer = next ?? sidebandCloser
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inflight = new Map<string, Promise<boolean>>()

/**
 * Ends a session now. Recorded in the ledger only when the close is confirmed; otherwise the sweeper retries.
 * A second call while a close is in flight shares it.
 */
export function closeSession(sessionId: string, reason: ledger.EndReason): Promise<boolean> {
  const t = timers.get(sessionId)
  if (t) clearTimeout(t)
  timers.delete(sessionId)
  const running = inflight.get(sessionId)
  if (running) return running
  const attempt = (async () => {
    // The avatar layer never outlives its voice session, whether or not the voice close is confirmed. It is
    // stopped alongside, so the voice close never waits on the avatar provider.
    void endAvatar(sessionId, reason === 'limit' ? 'limit' : 'voice_ended').catch(() => console.error('[avatar] could not end with its voice session', { sessionId }))
    try {
      const confirmed = (await closer.close(sessionId)) !== false
      if (confirmed) await ledger.markEnded(sessionId, reason)
      console.log('[live] closed session', { sessionId, reason, confirmed })
      return confirmed
    } catch {
      console.error('[live] could not close session; the sweeper will retry', { sessionId, reason })
      return false
    } finally {
      inflight.delete(sessionId)
    }
  })()
  inflight.set(sessionId, attempt)
  return attempt
}

/** Schedules the close at `deadline` (epoch ms). */
export function armSession(sessionId: string, deadline: number): void {
  const existing = timers.get(sessionId)
  if (existing) clearTimeout(existing)
  const delay = Math.max(0, deadline - now().getTime())
  const timer = setTimeout(() => void closeSession(sessionId, 'limit'), delay)
  timer.unref?.()
  timers.set(sessionId, timer)
}

/** Called right after a new session is created and recorded in the ledger. */
export async function onSessionStarted(session: { sessionId: string; userId: string; deadline: Date }): Promise<void> {
  armSession(session.sessionId, session.deadline.getTime())
  for (const prior of await ledger.otherOpenSessionsOf(session.userId, session.sessionId)) {
    void closeSession(prior.sessionId, 'replaced')
  }
}

/**
 * The leash. A tool call is served only for a session the ledger says is open, unexpired and not idle, by the
 * server clock. A session found over is closed on the spot.
 */
export async function verifyServable(sessionId: string, attemptId: string): Promise<ledger.SessionVerdict> {
  const session = await ledger.getSession(sessionId)
  const verdict = ledger.judge(session && session.attemptId === attemptId ? session : null)
  if (!verdict.ok && verdict.session && !verdict.session.endedAt) {
    if (verdict.code === 'live_session_expired') await ledger.flag(sessionId)
    void closeSession(sessionId, verdict.code === 'live_session_idle' ? 'idle' : 'limit')
  }
  return verdict
}

/**
 * One sweeper pass over open sessions: flag and close those past their deadline, close idle ones, and stop
 * blocking on a flagged session long after the provider must have ended it.
 */
export async function sweep(): Promise<{ expired: number; idle: number; assumed: number }> {
  const at = now()
  const result = { expired: 0, idle: 0, assumed: 0 }
  for (const s of await ledger.openSessions()) {
    if (at.getTime() >= s.deadlineAt.getTime() + ledger.ASSUME_ENDED_AFTER_MS) {
      await ledger.markEnded(s.sessionId, 'assumed_expired')
      console.error('[live] session close never confirmed; assuming the provider ended it', { sessionId: s.sessionId })
      result.assumed += 1
      continue
    }
    const verdict = ledger.judge(s, at)
    if (verdict.ok) continue
    if (verdict.code === 'live_session_expired') {
      await ledger.flag(s.sessionId)
      result.expired += 1
      await closeSession(s.sessionId, 'limit')
    } else if (verdict.code === 'live_session_idle') {
      result.idle += 1
      await closeSession(s.sessionId, 'idle')
    }
  }
  await sweepAvatars()
  return result
}

let sweeper: ReturnType<typeof setInterval> | null = null

/** On startup: re-arm open sessions' deadlines, run one sweep, then keep sweeping. */
export async function startSessionGuards(): Promise<{ armed: number; swept: Awaited<ReturnType<typeof sweep>> }> {
  let armed = 0
  for (const s of await ledger.openSessions()) {
    if (s.deadlineAt.getTime() > now().getTime()) {
      armSession(s.sessionId, s.deadlineAt.getTime())
      armed += 1
    }
  }
  const swept = await sweep()
  if (!sweeper) {
    sweeper = setInterval(() => {
      sweep().catch(() => console.error('[live] sweep failed; will retry'))
    }, env.LIVE_SWEEP_INTERVAL_MS)
    sweeper.unref?.()
  }
  return { armed, swept }
}

/** Test seam: waits for closes still in flight, so they cannot write into the next test. */
export async function settleSessionGuards(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight.values()])
}

/** Test seam: forget all timers, the sweeper and in-flight closes. */
export function resetSessionGuards(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  inflight.clear()
  if (sweeper) clearInterval(sweeper)
  sweeper = null
}
