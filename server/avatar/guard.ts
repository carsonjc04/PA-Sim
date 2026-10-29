import * as ledger from '../live/ledger'
import { now } from '../lib/clock'
import { avatarProvider } from './provider'

/**
 * Server-side lifecycle of the avatar layer. The avatar is minted with a provider-side maximum no later than
 * its voice session's deadline, so LiveAvatar ends it on its own at the voice cap. On top of that the server
 * stops it whenever its voice session closes (End session, cap, idle, replaced) and the sweeper stops any that
 * outlived their voice session or deadline. After a stop the provider's billed credits are fetched for the
 * attempt record.
 */

const inflight = new Map<string, Promise<void>>()
const reports = new Set<Promise<void>>()
let reportDelayMs = 5_000

/** Stops the avatar on a voice session, if one is open. Shares a stop already in flight. */
export function endAvatar(sessionId: string, reason: ledger.AvatarEndReason): Promise<void> {
  const running = inflight.get(sessionId)
  if (running) return running
  const run = (async () => {
    const avatar = await ledger.getAvatar(sessionId)
    if (!avatar || avatar.endedAt) return
    if (avatar.avatarSessionId) {
      try {
        await avatarProvider().stop(avatar.avatarSessionId)
      } catch {
        // The provider still ends it at its own maximum (never past the voice deadline); bill the ledger to then.
        console.error('[avatar] stop was not confirmed; the provider maximum ends it', { sessionId, reason })
      }
    }
    const ended = await ledger.markAvatarEnded(sessionId, reason)
    console.log('[avatar] ended', { sessionId, reason })
    if (ended && avatar.avatarSessionId) scheduleReport(sessionId, avatar.avatarSessionId)
  })().finally(() => inflight.delete(sessionId))
  inflight.set(sessionId, run)
  return run
}

/** The provider settles a session's credits shortly after it ends; fetch once, best effort. */
function scheduleReport(sessionId: string, avatarSessionId: string) {
  const report = new Promise<void>((resolve) => {
    const timer = setTimeout(async () => {
      try {
        const credits = await avatarProvider().credits(avatarSessionId)
        if (credits !== null) await ledger.setAvatarCredits(sessionId, credits)
      } catch {
        /* the attempt record falls back to the minute estimate */
      }
      resolve()
    }, reportDelayMs)
    timer.unref?.()
  })
  reports.add(report)
  void report.finally(() => reports.delete(report))
}

/** Sweeper pass: avatars whose voice session ended, or past their own deadline. */
export async function sweepAvatars(): Promise<number> {
  let ended = 0
  const at = now().getTime()
  for (const a of await ledger.openAvatars()) {
    if (a.voiceEnded) await endAvatar(a.sessionId, 'voice_ended')
    else if (a.deadlineAt && at >= a.deadlineAt.getTime()) await endAvatar(a.sessionId, 'limit')
    else continue
    ended += 1
  }
  return ended
}

/** Test seams. */
export async function settleAvatarGuards(): Promise<void> {
  while (inflight.size || reports.size) await Promise.allSettled([...inflight.values(), ...reports])
}
export function setAvatarReportDelay(ms: number): void {
  reportDelayMs = ms
}
