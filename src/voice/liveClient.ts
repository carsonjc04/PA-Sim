import { TranscriptAggregator } from './transcript'
import type {
  SessionUsage,
  StartVoiceOptions,
  VoiceClientEvents,
  VoiceConnectionState,
  VoiceError,
} from './types'

const DATA_CHANNEL_NAME = 'oai-events'
const ICE_GATHERING_TIMEOUT_MS = 3000
const CLOSE_ACK_TIMEOUT_MS = 1500
const PATIENT_SPEAKING_IDLE_MS = 900

interface FunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

function isFunctionCall(value: unknown): value is FunctionCallItem {
  const item = value as FunctionCallItem | undefined
  return (
    !!item &&
    item.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.arguments === 'string'
  )
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

export class LiveVoiceClient {
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private micStream: MediaStream | null = null
  private audioEl: HTMLAudioElement | null = null
  private state: VoiceConnectionState = 'idle'
  private aggregator = new TranscriptAggregator()
  private encounterId = ''
  private apiBaseUrl = ''
  private sessionId: string | null = null
  private pendingToolCalls = 0
  private speakingTimer: ReturnType<typeof setTimeout> | null = null
  private startedResolve: (() => void) | null = null

  private readonly events: VoiceClientEvents

  constructor(events: VoiceClientEvents) {
    this.events = events
  }

  getState(): VoiceConnectionState {
    return this.state
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  private setState(next: VoiceConnectionState) {
    if (this.state === next) return
    this.state = next
    this.events.onStateChange(next)
  }

  private fail(error: VoiceError): never {
    this.setState('error')
    this.events.onError(error)
    throw new Error(error.message)
  }

  async start({ encounterId, apiBaseUrl }: StartVoiceOptions): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'closed' && this.state !== 'error') return
    this.encounterId = encounterId
    this.apiBaseUrl = apiBaseUrl
    this.aggregator.reset()
    this.sessionId = null

    if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.fail({
        code: 'unsupported_browser',
        message: 'This browser does not support the microphone access voice mode needs.',
        recoverable: false,
      })
    }

    this.setState('requesting-microphone')
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (cause) {
      const name = (cause as { name?: string })?.name
      const denied = name === 'NotAllowedError' || name === 'SecurityError'
      this.fail({
        code: denied ? 'microphone_denied' : 'microphone_unavailable',
        message: denied
          ? 'Microphone access was blocked. Allow it in your browser, then try again.'
          : 'No usable microphone was found. Check your input device and try again.',
        recoverable: true,
      })
    }

    this.setState('connecting')
    const peer = new RTCPeerConnection()
    this.peer = peer

    for (const track of this.micStream!.getTracks()) peer.addTrack(track, this.micStream!)

    this.audioEl = document.createElement('audio')
    this.audioEl.autoplay = true
    peer.ontrack = (event) => {
      if (this.audioEl) this.audioEl.srcObject = event.streams[0] ?? null
    }

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' && this.state !== 'closing' && this.state !== 'closed') {
        this.setState('error')
        this.events.onError({
          code: 'webrtc_failed',
          message: 'The voice connection dropped. Check your network and reconnect.',
          recoverable: true,
        })
      }
    }

    // Must exist before the offer so it is negotiated in the same SDP.
    this.channel = peer.createDataChannel(DATA_CHANNEL_NAME)
    this.channel.onmessage = (event) => this.handleMessage(event.data)
    this.channel.onerror = () => {
      this.events.onError({
        code: 'data_channel_failed',
        message: 'The event channel failed. Transcripts may be incomplete.',
        recoverable: true,
      })
    }

    const started = new Promise<void>((resolve) => {
      this.startedResolve = resolve
    })

    await peer.setLocalDescription(await peer.createOffer())
    await this.waitForIceGathering(peer)

    let answer: { sessionId: string; sdp: string }
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/live/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: peer.localDescription!.sdp, encounterId }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null
        this.fail({
          code: body?.error?.code === 'missing_api_key' ? 'missing_api_key' : 'session_failed',
          message: body?.error?.message ?? 'Could not start the voice session.',
          recoverable: body?.error?.code !== 'missing_api_key',
        })
      }
      answer = (await response.json()) as { sessionId: string; sdp: string }
    } catch (cause) {
      if (this.state === 'error') throw cause
      this.fail({
        code: 'network',
        message: 'Could not reach the ClinicSim server. Check that the backend is running.',
        recoverable: true,
      })
    }

    this.sessionId = answer.sessionId
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp })

    // The session is only live once the server says so.
    await started
    this.setState('live')
  }

  private waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        peer.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
      const check = () => {
        if (peer.iceGatheringState === 'complete') done()
      }
      // Some networks never reach "complete"; the offer is still usable.
      const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS)
      peer.addEventListener('icegatheringstatechange', check)
    })
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== 'string') return
    let event: { type?: string; [key: string]: unknown }
    try {
      event = JSON.parse(raw)
    } catch {
      return
    }

    switch (event.type) {
      case 'session.started':
        this.startedResolve?.()
        this.startedResolve = null
        return

      case 'session.input_transcript.delta':
        this.events.onTranscript(
          this.aggregator.apply({
            speaker: 'student',
            delta: String(event.delta ?? ''),
            startMs: Number(event.start_ms ?? 0),
            endMs: Number(event.end_ms ?? 0),
          }),
        )
        return

      case 'session.output_transcript.delta':
        this.markPatientSpeaking()
        this.events.onTranscript(
          this.aggregator.apply({
            speaker: 'patient',
            delta: String(event.delta ?? ''),
            startMs: Number(event.start_ms ?? 0),
            endMs: Number(event.end_ms ?? 0),
          }),
        )
        return

      case 'session.usage.updated':
        this.events.onUsage((event.usage ?? {}) as SessionUsage)
        return

      case 'session.closed':
        this.setState('closed')
        return

      case 'error':
        this.events.onError({
          code: 'remote_error',
          message: 'The voice service reported an error.',
          recoverable: true,
        })
        return

      case 'response.event':
        this.handleDelegatedEvent(event.event as { type?: string; item?: unknown })
        return

      default:
        return
    }
  }

  /** Delegated backend events arrive wrapped; the real type is nested. */
  private handleDelegatedEvent(inner: { type?: string; item?: unknown } | undefined) {
    if (!inner || inner.type !== 'response.output_item.done') return
    if (!isFunctionCall(inner.item)) return
    void this.relayToolCall(inner.item)
  }

  private async relayToolCall(item: FunctionCallItem) {
    this.pendingToolCalls += 1
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/live/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encounterId: this.encounterId,
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        }),
      })
      const body = (await response.json()) as { output?: unknown; error?: { message?: string } }
      const output = response.ok ? body.output : { ok: false, reason: 'Tool call rejected.' }
      this.send({
        type: 'response.item.create',
        event_id: newId(),
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(output ?? { ok: false }),
        },
      })
    } catch {
      this.send({
        type: 'response.item.create',
        event_id: newId(),
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify({ ok: false, reason: 'The clinic system did not respond.' }),
        },
      })
    } finally {
      this.pendingToolCalls -= 1
      // Only ask for a new response once every outstanding output is supplied.
      if (this.pendingToolCalls === 0) {
        this.send({ type: 'response.create', event_id: newId() })
      }
    }
  }

  private markPatientSpeaking() {
    this.events.onPatientSpeakingChange(true)
    if (this.speakingTimer) clearTimeout(this.speakingTimer)
    this.speakingTimer = setTimeout(() => {
      this.events.onPatientSpeakingChange(false)
      this.speakingTimer = null
    }, PATIENT_SPEAKING_IDLE_MS)
  }

  private send(payload: unknown) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(payload))
  }

  /** Disables the outbound track. The session stays open and keeps billing. */
  setMuted(muted: boolean): void {
    for (const track of this.micStream?.getAudioTracks() ?? []) track.enabled = !muted
  }

  isMuted(): boolean {
    const track = this.micStream?.getAudioTracks()[0]
    return track ? !track.enabled : false
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'closed') {
      this.teardown()
      return
    }
    this.setState('closing')

    // Listener is registered before the close request so a fast ack is not lost.
    const closed = new Promise<void>((resolve) => {
      const onClose = (event: MessageEvent) => {
        try {
          if (JSON.parse(String(event.data))?.type === 'session.closed') {
            this.channel?.removeEventListener('message', onClose)
            resolve()
          }
        } catch {
          /* non-JSON frames are not close acknowledgements */
        }
      }
      this.channel?.addEventListener('message', onClose)
      // Cleanup must finish even if the acknowledgement never arrives.
      setTimeout(resolve, CLOSE_ACK_TIMEOUT_MS)
    })

    this.send({ type: 'session.close' })
    await closed
    this.teardown()
    this.setState('closed')
  }

  private teardown() {
    if (this.speakingTimer) {
      clearTimeout(this.speakingTimer)
      this.speakingTimer = null
    }
    this.startedResolve = null

    try {
      this.channel?.close()
    } catch {
      /* already closed */
    }
    this.channel = null

    if (this.peer) {
      this.peer.ontrack = null
      this.peer.onconnectionstatechange = null
      try {
        this.peer.close()
      } catch {
        /* already closed */
      }
      this.peer = null
    }

    for (const track of this.micStream?.getTracks() ?? []) track.stop()
    this.micStream = null

    if (this.audioEl) {
      this.audioEl.srcObject = null
      this.audioEl = null
    }
    this.pendingToolCalls = 0
  }
}
