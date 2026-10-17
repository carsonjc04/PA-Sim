import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { AiStatus } from '../../api/contracts'
import { useVoiceEncounter } from '../../voice/useVoiceEncounter'
import type { VoiceConnectionState } from '../../voice/types'

const statusLabel: Record<VoiceConnectionState, string> = {
  idle: 'Not connected',
  'requesting-microphone': 'Waiting for microphone permission',
  connecting: 'Connecting',
  live: 'Connected',
  closing: 'Ending session',
  closed: 'Session ended',
  error: 'Problem',
}

const usd = (n: number) => `$${n.toFixed(2)}`
const minutesBetween = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 60_000))
const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Optional voice layer over the same attempt as guided mode. Cost is stated in plain language before and during
 * a session, End session is always beside Mute (muting does not stop billing), and the session ends itself at
 * the server's deadline. The server enforces the same deadline and an idle timeout on its own (see
 * server/live/sessionGuard.ts); the browser ends first so the learner sees why.
 */
export function VoicePanel({ attemptId, onActivity, onToolRejected }: { attemptId: string; onActivity?: () => void; onToolRejected?: (reason: string) => void }) {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [autoEnded, setAutoEnded] = useState<'limit' | 'idle' | null>(null)
  const voice = useVoiceEncounter(attemptId, onToolRejected)
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => setUnreachable(true))
  }, [])

  // Voice tool calls record server-side; tell the page to refresh its view of the attempt.
  const transcriptLength = voice.transcript.length
  useEffect(() => {
    if (transcriptLength > 0) onActivity?.()
  }, [transcriptLength, onActivity])

  // Tick while connected so the countdown, the estimate and the idle check stay current.
  const connectedAt = voice.connectedAt
  useEffect(() => {
    if (connectedAt === null) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [connectedAt])

  // End at the server's deadline (the encounter's remaining voice budget). The server closes it there anyway.
  const max = status?.maxSessionMinutes ?? null
  const deadline = voice.deadlineAt ?? (connectedAt !== null && max !== null ? connectedAt + max * 60_000 : null)
  const { disconnect } = voice
  useEffect(() => {
    if (deadline === null) return
    const t = setTimeout(
      () => {
        setAutoEnded('limit')
        disconnect()
      },
      Math.max(0, deadline - Date.now()),
    )
    return () => clearTimeout(t)
  }, [deadline, disconnect])

  // Abandoned tabs: warn after half the server's idle timeout with no speech, end at three quarters.
  const idleSeconds = status?.idleTimeoutSeconds ?? null
  const quietMs = connectedAt !== null && voice.lastSpeechAt !== null ? now - voice.lastSpeechAt : 0
  const idleWarning = idleSeconds !== null && quietMs >= (idleSeconds * 1000) / 2
  useEffect(() => {
    if (connectedAt === null || idleSeconds === null || voice.lastSpeechAt === null) return
    const t = setTimeout(
      () => {
        setAutoEnded('idle')
        disconnect()
      },
      Math.max(0, voice.lastSpeechAt + idleSeconds * 750 - Date.now()),
    )
    return () => clearTimeout(t)
  }, [connectedAt, idleSeconds, voice.lastSpeechAt, disconnect])

  // Move focus to a new error (for example a blocked microphone) so it is read out and actionable.
  const errorCode = voice.error?.code
  const ready = status !== null
  useEffect(() => {
    if (errorCode && ready) errorRef.current?.focus()
  }, [errorCode, ready])

  if (unreachable)
    return (
      <section className="voice-panel voice-panel--setup" aria-labelledby="voice-title">
        <h2 id="voice-title">Voice is unavailable</h2>
        <p>The ClinicSim server could not be reached, so voice cannot start. Guided mode works without voice.</p>
      </section>
    )
  if (!status) return <section className="voice-panel">Checking voice availability…</section>

  if (!status.aiEnabled)
    return (
      <section className="voice-panel voice-panel--setup" aria-labelledby="voice-title">
        <h2 id="voice-title">Voice is not set up</h2>
        <p>{status.setupHint}</p>
        <p className="voice-fallback">Guided mode is complete without voice, a microphone or an AI key.</p>
      </section>
    )

  const { state } = voice
  const connecting = state === 'requesting-microphone' || state === 'connecting'
  const active = state === 'live' || connecting || state === 'closing'
  const rate = status.estimatedVoiceRatePerMinuteUsd
  const minutes = connectedAt === null ? 0 : minutesBetween(connectedAt, now)
  // The estimate counts the current minute as used, so it errs high rather than low.
  const estimate = connectedAt === null ? 0 : (minutes + 1) * rate
  const remainingMs = connectedAt === null || deadline === null ? null : deadline - now
  const dropped = voice.error?.code === 'webrtc_failed'

  return (
    <section className="voice-panel" aria-labelledby="voice-title">
      <header className="voice-header">
        <h2 id="voice-title">Voice conversation</h2>
        <span className={`voice-status voice-status--${state}`}>{state === 'live' && voice.patientSpeaking ? 'Patient speaking' : statusLabel[state]}</span>
      </header>

      <p className="voice-cost">
        Voice uses a paid AI service: about {usd(rate)} per minute while connected, for up to {max} minutes (about {usd((max ?? 0) * rate)} in total).{' '}
        <strong>Muting does not stop the charge; End session does.</strong>{' '}
        {status.storeTranscripts ? 'This server may store the conversation transcript.' : 'The conversation transcript is not saved.'}
      </p>

      {remainingMs !== null && (
        <p className="voice-timer">
          Time left <span role="timer" aria-label={`${clock(remainingMs)} left`}>{clock(remainingMs)}</span>
        </p>
      )}

      {connectedAt !== null && (
        <p className="voice-meter" role="status">
          Connected {minutes} {minutes === 1 ? 'minute' : 'minutes'}, about {usd(estimate)} so far (an estimate, not a bill).
          {remainingMs !== null && remainingMs <= 2 * 60_000 && ` Wrapping up: summarize and close. The session ends in ${remainingMs < 60_000 ? 'under a minute' : `${Math.ceil(remainingMs / 60_000)} minutes`}.`}
        </p>
      )}

      {idleWarning && state === 'live' && (
        <p className="voice-hint voice-hint--warning" role="alert">
          <strong>Still there?</strong> The session ends soon if no one speaks.
        </p>
      )}

      {!active && !dropped && (
        <button type="button" onClick={voice.connect}>
          {state === 'closed' ? 'Start a new voice session' : 'Connect voice'}
        </button>
      )}

      {state === 'requesting-microphone' && <p className="voice-hint">Your browser is asking for microphone access. Choose Allow.</p>}

      {active && (
        <div className="voice-controls">
          <button type="button" onClick={voice.toggleMute} aria-pressed={voice.muted}>
            {voice.muted ? 'Unmute' : 'Mute'}
          </button>
          <button type="button" className="voice-end" onClick={voice.disconnect}>
            End session
          </button>
        </div>
      )}

      {voice.muted && active && (
        <p className="voice-hint voice-hint--warning">
          <strong>Muted: still connected and still billed.</strong> Choose End session to stop.
        </p>
      )}

      {state === 'closed' && !voice.error && (
        <p className="voice-hint">
          {voice.endedByServer ??
            (autoEnded === 'limit'
              ? `Session ended at this encounter's ${max}-minute voice limit to cap the cost.`
              : autoEnded === 'idle'
                ? 'Session ended after a quiet stretch so it would stop billing.'
                : 'Session ended. You are no longer billed.')}
        </p>
      )}

      {voice.error && (
        <div className="voice-error" role="alert" tabIndex={-1} ref={errorRef}>
          {dropped ? (
            <>
              <p>
                <strong>Connection lost.</strong> You are not billed while disconnected, and your guided progress is saved.
              </p>
              <button type="button" onClick={voice.retry}>
                Reconnect voice
              </button>
            </>
          ) : (
            <>
              <p>{voice.error.message}</p>
              {voice.error.code === 'microphone_denied' && <p className="voice-help">To allow it, use the microphone or lock icon in the address bar, then choose Try again.</p>}
              {voice.error.recoverable && (
                <button type="button" onClick={voice.retry}>
                  Try again
                </button>
              )}
            </>
          )}
          <p className="voice-fallback">You can continue in guided mode instead.</p>
        </div>
      )}

      {voice.transcript.length > 0 && (
        <ol className="voice-transcript" aria-label="Voice transcript (not saved)">
          {voice.transcript.map((segment) => (
            <li key={segment.id} className={`voice-turn voice-turn--${segment.speaker}`}>
              <span className="voice-speaker">{segment.speaker === 'student' ? 'You said' : 'Patient said'}</span>
              <p>{segment.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
