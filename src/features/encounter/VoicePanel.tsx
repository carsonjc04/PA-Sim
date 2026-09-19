import { useEffect, useRef, useState } from 'react'
import { useVoiceEncounter } from '../../voice/useVoiceEncounter'
import type { VoiceConnectionState } from '../../voice/types'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787'

const statusLabel: Record<VoiceConnectionState, string> = {
  idle: 'Not connected',
  'requesting-microphone': 'Waiting for microphone permission',
  connecting: 'Connecting',
  live: 'Live',
  closing: 'Ending conversation',
  closed: 'Conversation ended',
  error: 'Problem',
}

interface AiStatus {
  aiEnabled: boolean
  setupHint: string | null
}

export function VoicePanel({ scenarioId }: { scenarioId: string }) {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [encounterId, setEncounterId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const wantsConnect = useRef(false)
  const voice = useVoiceEncounter(encounterId)

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/ai/status`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() =>
        setStatus({
          aiEnabled: false,
          setupHint: 'The ClinicSim backend is not reachable. Start it with npm run dev:server.',
        }),
      )
  }, [])

  // The encounter must exist on the server before a session can reference it.
  useEffect(() => {
    if (encounterId && wantsConnect.current) {
      wantsConnect.current = false
      voice.connect()
    }
  }, [encounterId, voice])

  const beginEncounter = async () => {
    setStartError(null)
    setStarting(true)
    try {
      const response = await fetch(`${apiBaseUrl}/api/encounters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId, mode: 'voice-handcrafted' }),
      })
      const body = await response.json()
      if (!response.ok) {
        setStartError(body?.error?.message ?? 'Could not start a voice encounter.')
        return
      }
      wantsConnect.current = true
      setEncounterId(body.id)
    } catch {
      setStartError('Could not reach the ClinicSim server.')
    } finally {
      setStarting(false)
    }
  }

  if (!status) return <section className="voice-panel">Checking voice availability...</section>

  if (!status.aiEnabled) {
    return (
      <section className="voice-panel voice-panel--setup">
        <h3>Voice mode is not configured</h3>
        <p>{status.setupHint}</p>
        <p className="voice-fallback">
          Guided mode below works without a key, a microphone, or a network connection.
        </p>
      </section>
    )
  }

  const { state } = voice
  const connecting = state === 'requesting-microphone' || state === 'connecting'
  const active = state === 'live' || connecting || state === 'closing'

  return (
    <section className="voice-panel">
      <header className="voice-header">
        <h3>AI voice encounter</h3>
        <span className={`voice-status voice-status--${state}`} role="status">
          {/* Never render as live before session.started arrives. */}
          {state === 'live' && voice.patientSpeaking ? 'Patient speaking' : statusLabel[state]}
        </span>
      </header>

      {!active && (
        <button type="button" onClick={beginEncounter} disabled={starting}>
          {starting ? 'Preparing...' : 'Connect voice'}
        </button>
      )}

      {state === 'requesting-microphone' && (
        <p className="voice-hint">Your browser is asking for microphone access. Choose Allow.</p>
      )}

      {startError && <p className="voice-error">{startError}</p>}

      {voice.error && (
        <div className="voice-error" role="alert">
          <p>{voice.error.message}</p>
          {voice.error.recoverable && (
            <button type="button" onClick={voice.retry}>
              Try again
            </button>
          )}
          <p className="voice-fallback">You can continue in guided mode below instead.</p>
        </div>
      )}

      {active && (
        <div className="voice-controls">
          <button type="button" onClick={voice.toggleMute} aria-pressed={voice.muted}>
            {voice.muted ? 'Unmute' : 'Mute'}
          </button>
          <button type="button" onClick={voice.disconnect}>
            End conversation
          </button>
        </div>
      )}

      {voice.muted && (
        <p className="voice-hint">
          Muted. The session is still open and still billed until you end the conversation.
        </p>
      )}

      <ol className="voice-transcript">
        {voice.transcript.map((segment) => (
          <li key={segment.id} className={`voice-turn voice-turn--${segment.speaker}`}>
            <span className="voice-speaker">
              {segment.speaker === 'student' ? 'You — PA Student' : 'Patient'}
            </span>
            <p>{segment.text}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
