import { useCallback, useEffect, useRef, useState } from 'react'
import { apiBaseUrl, authHeaders } from '../api/client'
import type { AvatarFailure, AvatarGrant, AvatarLayer, AvatarMedia } from './avatarLayer'
import { LiveVoiceClient } from './liveClient'
import type {
  SessionUsage,
  TranscriptSegment,
  VoiceConnectionState,
  VoiceError,
  VoicePresence,
} from './types'

// Student speech arrives as transcript deltas; this long without one ends "listening".
const STUDENT_SPEAKING_IDLE_MS = 900
// After the student stops, "thinking" lasts until the patient replies or this long passes.
const REPLY_WAIT_MS = 8_000

export type VoiceMode = 'voice' | 'avatar'
/** The avatar layer over a voice session: off (voice-only), starting, live, or ended (degraded to voice-only). */
export type AvatarState = 'off' | 'starting' | 'live' | 'ended'

const failureNotice: Record<AvatarFailure, string> = {
  start_failed: 'The avatar could not start, so the patient continues as voice only.',
  socket_closed: 'The avatar connection dropped, so the patient continues as voice only.',
  provider_error: 'The avatar service reported a problem, so the patient continues as voice only.',
  room_disconnected: 'The avatar video dropped, so the patient continues as voice only.',
  time_limit: 'The avatar reached its time limit, so the patient continues as voice only.',
}
const UNCHANGED = ' Your transcript and progress are unchanged.'

/** Loads the avatar layer and LiveKit only when a learner picks Avatar + Voice. */
async function loadAvatar(events: ConstructorParameters<typeof AvatarLayer>[0]): Promise<AvatarLayer> {
  const [{ AvatarLayer: Layer }, { browserAvatarDeps }] = await Promise.all([import('./avatarLayer'), import('./avatarBrowser')])
  return new Layer(events, browserAvatarDeps)
}
let avatarLoader = loadAvatar
/** Test seam. */
export function setAvatarLoader(next: typeof loadAvatar | null): void {
  avatarLoader = next ?? loadAvatar
}

export interface VoiceEncounter {
  state: VoiceConnectionState
  transcript: TranscriptSegment[]
  error: VoiceError | null
  patientSpeaking: boolean
  /** Portrait presence: listening, thinking or speaking while live, otherwise idle. */
  presence: VoicePresence
  muted: boolean
  usage: SessionUsage | null
  /** When the session became live (billing starts), or null when not connected. */
  connectedAt: number | null
  /** The server's deadline for this session (epoch ms), or null when not connected. */
  deadlineAt: number | null
  /** Last time the student was heard (epoch ms), for the idle warning. */
  lastSpeechAt: number | null
  /** Why the server ended the session, when it did. */
  endedByServer: string | null
  avatar: AvatarState
  /** Why the avatar ended, in plain language, when it degraded to voice-only. */
  avatarNotice: string | null
  /** When the avatar went live (its minutes count from here), or null. */
  avatarSince: number | null
  /** When the avatar ended, or null while it runs. */
  avatarUntil: number | null
  /** Starts voice; with 'avatar', the avatar layer follows once voice is live. Chosen before the session. */
  connect: (mode?: VoiceMode) => void
  /** Stops the avatar only; voice continues. */
  stopAvatar: () => void
  disconnect: () => void
  toggleMute: () => void
  retry: () => void
}

export function useVoiceEncounter(
  attemptId: string | null,
  onToolRejected?: (reason: string) => void,
  /** Where the avatar's face and voice play; required for Avatar + Voice. */
  avatarMedia?: () => AvatarMedia | null,
): VoiceEncounter {
  const [state, setState] = useState<VoiceConnectionState>('idle')
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  const [error, setError] = useState<VoiceError | null>(null)
  const [patientSpeaking, setPatientSpeaking] = useState(false)
  const [muted, setMuted] = useState(false)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null)
  const [lastSpeechAt, setLastSpeechAt] = useState<number | null>(null)
  const [endedByServer, setEndedByServer] = useState<string | null>(null)
  const [studentSpeaking, setStudentSpeaking] = useState(false)
  const [awaitingReply, setAwaitingReply] = useState(false)
  const speechTimers = useRef<{ student?: ReturnType<typeof setTimeout>; reply?: ReturnType<typeof setTimeout> }>({})
  const clientRef = useRef<LiveVoiceClient | null>(null)
  const [avatar, setAvatar] = useState<AvatarState>('off')
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null)
  const [avatarSince, setAvatarSince] = useState<number | null>(null)
  const [avatarUntil, setAvatarUntil] = useState<number | null>(null)
  const wantAvatar = useRef(false)
  const layerRef = useRef<AvatarLayer | null>(null)
  const mediaRef = useRef(avatarMedia)
  useEffect(() => {
    mediaRef.current = avatarMedia
  })
  const rejectedRef = useRef(onToolRejected)
  useEffect(() => {
    rejectedRef.current = onToolRejected
  })

  const ensureClient = useCallback(() => {
    if (!clientRef.current) {
      clientRef.current = new LiveVoiceClient({
        onStateChange: (next) => {
          setState(next)
          if (next === 'live') {
            setConnectedAt((at) => at ?? Date.now())
            setLastSpeechAt(Date.now())
            setDeadlineAt(clientRef.current?.getDeadline() ?? null)
          } else if (next !== 'closing') {
            setConnectedAt(null)
            setDeadlineAt(null)
          }
        },
        onStudentSpeech: () => {
          // Voice owns barge-in: the avatar drops what it was saying the moment the student is heard.
          layerRef.current?.interrupt()
          setLastSpeechAt(Date.now())
          setStudentSpeaking(true)
          setAwaitingReply(true)
          const timers = speechTimers.current
          clearTimeout(timers.student)
          clearTimeout(timers.reply)
          timers.student = setTimeout(() => setStudentSpeaking(false), STUDENT_SPEAKING_IDLE_MS)
          timers.reply = setTimeout(() => setAwaitingReply(false), REPLY_WAIT_MS)
        },
        onSessionOver: (reason) => {
          setEndedByServer(reason)
          void clientRef.current?.stop().catch(() => undefined)
        },
        onToolRejected: (reason) => rejectedRef.current?.(reason),
        onTranscript: setTranscript,
        onError: setError,
        onUsage: setUsage,
        onPatientSpeakingChange: (speaking) => {
          setPatientSpeaking(speaking)
          if (speaking) setAwaitingReply(false)
        },
      })
    }
    return clientRef.current
  }, [])

  /** Voice-only from here on: unmute the patient's own voice first, so no words are lost, then drop the avatar. */
  const endAvatar = useCallback(
    (reason: 'failed' | 'client_end', notice: string | null) => {
      const client = clientRef.current
      client?.setRemoteAudioMuted(false)
      const layer = layerRef.current
      layerRef.current = null
      layer?.stop()
      wantAvatar.current = false
      setAvatar((a) => (a === 'off' ? a : 'ended'))
      setAvatarUntil((u) => u ?? Date.now())
      setAvatarNotice(notice)
      const sessionId = client?.getSessionId()
      if (sessionId && attemptId) {
        void fetch(`${apiBaseUrl}/api/live/avatar/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ attemptId, sessionId, reason }),
          keepalive: true,
        }).catch(() => undefined)
      }
    },
    [attemptId],
  )

  const startAvatar = useCallback(async () => {
    const client = clientRef.current
    const sessionId = client?.getSessionId()
    const stream = client?.getRemoteStream()
    const media = mediaRef.current?.()
    if (!client || !sessionId || !attemptId) return
    setAvatar('starting')
    const degrade = (notice: string) => endAvatar('failed', notice + UNCHANGED)
    if (!stream || !media) return degrade(failureNotice.start_failed)
    let grant: AvatarGrant
    try {
      const response = await fetch(`${apiBaseUrl}/api/live/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ attemptId, sessionId }),
      })
      const body = (await response.json().catch(() => null)) as (AvatarGrant & { error?: { message?: string } }) | null
      if (!response.ok || !body) {
        // The server already recorded the failed start; there is nothing to end.
        wantAvatar.current = false
        setAvatar('ended')
        setAvatarNotice((body?.error?.message ?? failureNotice.start_failed) + UNCHANGED)
        return
      }
      grant = body
    } catch {
      wantAvatar.current = false
      setAvatar('ended')
      setAvatarNotice(failureNotice.start_failed + UNCHANGED)
      return
    }
    if (clientRef.current !== client || !wantAvatar.current) return
    try {
      const layer = await avatarLoader({
        onReady: () => {
          if (layerRef.current !== layer) return
          client.setRemoteAudioMuted(true)
          setAvatarSince(Date.now())
          setAvatar('live')
        },
        onFailure: (reason) => {
          if (layerRef.current === layer) degrade(failureNotice[reason])
        },
      })
      layerRef.current = layer
      await layer.start(grant, stream, media)
    } catch {
      degrade(failureNotice.start_failed)
    }
  }, [attemptId, endAvatar])

  // The avatar follows voice: requested once voice is live, dropped when voice ends.
  useEffect(() => {
    if (state === 'live' && wantAvatar.current && avatar === 'off') void startAvatar()
    if (state !== 'live' && state !== 'closing' && layerRef.current) {
      layerRef.current.stop()
      layerRef.current = null
    }
  }, [state, avatar, startAvatar])

  const stopAvatar = useCallback(() => endAvatar('client_end', 'Avatar stopped. The patient continues as voice only.'), [endAvatar])

  const connect = useCallback((mode: VoiceMode = 'voice') => {
    if (!attemptId) return
    wantAvatar.current = mode === 'avatar'
    setAvatar('off')
    setAvatarSince(null)
    setAvatarUntil(null)
    setAvatarNotice(null)
    setError(null)
    setEndedByServer(null)
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
    const timers = speechTimers.current
    return () => {
      clearTimeout(timers.student)
      clearTimeout(timers.reply)
      const client = clientRef.current
      clientRef.current = null
      layerRef.current?.stop()
      layerRef.current = null
      void client?.stop().catch(() => undefined)
    }
  }, [attemptId])

  const presence: VoicePresence =
    state !== 'live' ? 'idle' : patientSpeaking ? 'speaking' : studentSpeaking ? 'listening' : awaitingReply ? 'thinking' : 'idle'

  return {
    state,
    transcript,
    error,
    patientSpeaking,
    presence,
    muted,
    usage,
    connectedAt,
    deadlineAt,
    lastSpeechAt,
    endedByServer,
    avatar,
    avatarNotice,
    avatarSince,
    avatarUntil,
    connect,
    stopAvatar,
    disconnect,
    toggleMute,
    retry,
  }
}
