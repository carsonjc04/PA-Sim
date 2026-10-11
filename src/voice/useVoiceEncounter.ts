import { useCallback, useEffect, useRef, useState } from 'react'
import { apiBaseUrl, authHeaders } from '../api/client'
import { LiveVoiceClient } from './liveClient'
import type {
  SessionUsage,
  TranscriptSegment,
  VoiceConnectionState,
  VoiceError,
} from './types'

export interface VoiceEncounter {
  state: VoiceConnectionState
  transcript: TranscriptSegment[]
  error: VoiceError | null
  patientSpeaking: boolean
  muted: boolean
  usage: SessionUsage | null
  /** When the session became live (billing starts), or null when not connected. */
  connectedAt: number | null
  connect: () => void
  disconnect: () => void
  toggleMute: () => void
  retry: () => void
}

export function useVoiceEncounter(attemptId: string | null, onToolRejected?: (reason: string) => void): VoiceEncounter {
  const [state, setState] = useState<VoiceConnectionState>('idle')
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  const [error, setError] = useState<VoiceError | null>(null)
  const [patientSpeaking, setPatientSpeaking] = useState(false)
  const [muted, setMuted] = useState(false)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const clientRef = useRef<LiveVoiceClient | null>(null)
  const rejectedRef = useRef(onToolRejected)
  useEffect(() => {
    rejectedRef.current = onToolRejected
  })

  const ensureClient = useCallback(() => {
    if (!clientRef.current) {
      clientRef.current = new LiveVoiceClient({
        onStateChange: (next) => {
          setState(next)
          if (next === 'live') setConnectedAt((at) => at ?? Date.now())
          else if (next !== 'closing') setConnectedAt(null)
        },
        onToolRejected: (reason) => rejectedRef.current?.(reason),
        onTranscript: setTranscript,
        onError: setError,
        onUsage: setUsage,
        onPatientSpeakingChange: setPatientSpeaking,
      })
    }
    return clientRef.current
  }, [])

  const connect = useCallback(() => {
    if (!attemptId) return
    setError(null)
    // start() reports failures through onError; the rejection is the same error.
    void ensureClient()
      .start({ attemptId, apiBaseUrl, headers: authHeaders })
      .catch(() => undefined)
  }, [attemptId, ensureClient])

  const disconnect = useCallback(() => {
    void clientRef.current?.stop().catch(() => undefined)
  }, [])

  const toggleMute = useCallback(() => {
    const client = clientRef.current
    if (!client) return
    const next = !client.isMuted()
    client.setMuted(next)
    setMuted(next)
  }, [])

  const retry = useCallback(() => {
    setTranscript([])
    connect()
  }, [connect])

  // A session is billed for as long as it is open, so leaving the encounter or
  // switching cases must close it rather than let it linger.
  useEffect(() => {
    return () => {
      const client = clientRef.current
      clientRef.current = null
      void client?.stop().catch(() => undefined)
    }
  }, [attemptId])

  return {
    state,
    transcript,
    error,
    patientSpeaking,
    muted,
    usage,
    connectedAt,
    connect,
    disconnect,
    toggleMute,
    retry,
  }
}
