import { SidebandWS } from 'openai/resources/live/sideband/ws'
import { env } from '../config/env'
import { getPool } from '../db/pool'
import { now } from '../lib/clock'
import { openaiClient } from '../openai/client'

/**
 * Server-side kill switch for billed Live voice sessions.
 *
 * The browser talks to OpenAI directly over WebRTC, so the browser's own timer cannot be trusted to end a
 * session: a modified client, or a timer that never fires, would keep the meter running. The server created
 * the session, so it also ends it:
 * - at creation it schedules a close at the deadline (MAX_LIVE_SESSION_MINUTES);
 * - every tool relay checks the deadline, refuses calls past it and closes the session (the backstop if a
 *   timer was lost, for example across a restart);
 * - starting a new session closes the attempt's previous one, so one attempt never has two meters running;
 * - on startup, sessions still inside their window are re-armed and recently expired ones are closed.
 *
 * Closing uses a trusted sideband connection to the session and sends `session.close`. Closing an already
 * closed session is harmless; failures are logged (session ID only) and retried by the next check.
 */

export interface SessionCloser {
  close(sessionId: string): Promise<void>
}

const CLOSE_TIMEOUT_MS = 5_000

/** Attaches a sideband WebSocket to the session, asks it to close, and waits for the close (bounded). */
export const sidebandCloser: SessionCloser = {
  close(sessionId) {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new SidebandWS(openaiClient(), { session_id: sessionId })
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* already closed */
        }
        if (error) reject(error instanceof Error ? error : new Error('sideband close failed'))
        else resolve()
      }
      const timer = setTimeout(() => finish(), CLOSE_TIMEOUT_MS)
      ws.on('session.closed', () => finish())
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
const closed = new Set<string>()

export const sessionLimitMs = () => env.MAX_LIVE_SESSION_MINUTES * 60_000

/** Ends a session now (idempotent within this process). */
export async function closeSession(sessionId: string, reason: 'limit' | 'replaced' | 'expired'): Promise<void> {
  const t = timers.get(sessionId)
  if (t) clearTimeout(t)
  timers.delete(sessionId)
  if (closed.has(sessionId)) return
  closed.add(sessionId)
  try {
    await closer.close(sessionId)
    console.log('[live] closed session', { sessionId, reason })
  } catch {
    // Allow a later check (tool relay, restart sweep) to try again.
    closed.delete(sessionId)
    console.error('[live] could not close session; will retry on the next check', { sessionId, reason })
  }
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

interface StartedSession {
  sessionId: string
  startedAt: number
  attemptId: string
}

/** Live sessions recorded for an attempt, newest first. */
async function sessionsFor(attemptId: string): Promise<StartedSession[]> {
  const { rows } = await getPool().query<{ session_id: string; created_at: Date; attempt_id: string }>(
    `SELECT detail->>'sessionId' AS session_id, created_at, attempt_id FROM attempt_events
     WHERE attempt_id = $1 AND type = 'live_started' AND detail->>'sessionId' IS NOT NULL ORDER BY seq DESC`,
    [attemptId],
  )
  return rows.map((r) => ({ sessionId: r.session_id, startedAt: r.created_at.getTime(), attemptId: r.attempt_id }))
}

/** Called right after a new session is created and recorded. */
export async function onSessionStarted(attemptId: string, sessionId: string): Promise<void> {
  armSession(sessionId, now().getTime() + sessionLimitMs())
  for (const prior of (await sessionsFor(attemptId)).filter((s) => s.sessionId !== sessionId)) {
    if (now().getTime() - prior.startedAt < sessionLimitMs() + 60 * 60_000) void closeSession(prior.sessionId, 'replaced')
  }
}

/**
 * The validation-path check for tool relays. Returns false (and closes the session) when the attempt's
 * current voice session is past its limit, so the server stops serving it whatever the browser does.
 */
export async function assertSessionWithinLimit(attemptId: string): Promise<boolean> {
  const [latest] = await sessionsFor(attemptId)
  if (!latest) return true
  if (now().getTime() - latest.startedAt <= sessionLimitMs()) return true
  await closeSession(latest.sessionId, 'expired')
  return false
}

/** On startup: re-arm sessions still inside their window and close ones that expired while the server was down. */
export async function resumeSessionGuards(): Promise<{ armed: number; closed: number }> {
  const limit = sessionLimitMs()
  const { rows } = await getPool().query<{ session_id: string; created_at: Date }>(
    `SELECT detail->>'sessionId' AS session_id, created_at FROM attempt_events
     WHERE type = 'live_started' AND detail->>'sessionId' IS NOT NULL AND created_at > $1`,
    [new Date(now().getTime() - limit - 60 * 60_000)],
  )
  let armed = 0
  let closedCount = 0
  for (const r of rows) {
    const deadline = r.created_at.getTime() + limit
    if (deadline > now().getTime()) {
      armSession(r.session_id, deadline)
      armed += 1
    } else {
      void closeSession(r.session_id, 'expired')
      closedCount += 1
    }
  }
  return { armed, closed: closedCount }
}

/** Test seam: forget all timers and close records. */
export function resetSessionGuards(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  closed.clear()
}
