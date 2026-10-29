/**
 * Avatar + Voice: renders the voice session's patient audio as a LiveAvatar face. Voice stays the source of
 * truth. The patient's Realtime audio track is tapped in the browser, converted to 24 kHz mono PCM16 and sent
 * to the avatar over its event socket; the learner hears the avatar's own audio, which LiveAvatar keeps in sync
 * with the face, while the Realtime track is muted (never removed). The avatar has no turn-taking of its own:
 * an utterance ends when the voice audio goes quiet, and student speech (the voice session's signal) interrupts
 * it. Any failure is reported once through onFailure; the caller unmutes the Realtime track and voice goes on.
 */

export interface AvatarGrant {
  avatarSessionId: string
  livekitUrl: string
  livekitClientToken: string
  wsUrl: string
  deadlineAt: string
}

export type AvatarFailure = 'start_failed' | 'socket_closed' | 'provider_error' | 'room_disconnected' | 'time_limit'

export interface AvatarLayerEvents {
  onReady: () => void
  onFailure: (reason: AvatarFailure) => void
}

export interface AvatarSocket {
  send(data: string): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface AvatarDeps {
  openSocket(url: string): AvatarSocket
  /** Joins the avatar's LiveKit room and plays its face and voice into the given elements. */
  joinRoom(url: string, token: string, media: AvatarMedia, onDisconnected: () => void): Promise<{ leave(): void }>
  /** Streams mono float frames of `stream` at the returned sample rate. */
  tap(stream: MediaStream, onFrame: (frame: Float32Array, sampleRate: number) => void): Promise<{ stop(): void }>
  now(): number
}

export interface AvatarMedia {
  video: HTMLVideoElement
  audio: HTMLAudioElement
}

export const AVATAR_RATE = 24_000
const CHUNK_SAMPLES = AVATAR_RATE / 5 // 200 ms per agent.speak
const SILENCE_END_MS = 600
const SPEECH_RMS = 0.004
const CONNECT_TIMEOUT_MS = 15_000
const KEEP_ALIVE_MS = 60_000

const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2))

export function toBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Linear resampler to 24 kHz that carries its position across frames, so chunk joins do not click. */
export class Resampler {
  private pos = 0
  private last = 0
  push(frame: Float32Array, rate: number): Float32Array {
    if (rate === AVATAR_RATE) return frame
    const step = rate / AVATAR_RATE
    const out: number[] = []
    // Position is measured from the last sample of the previous frame (index -1).
    while (this.pos < frame.length - 1 + 1e-9) {
      const i = Math.floor(this.pos)
      const t = this.pos - i
      const a = i < 0 ? this.last : frame[i]
      const b = frame[Math.min(i + 1, frame.length - 1)]
      out.push(a + (b - a) * t)
      this.pos += step
    }
    this.pos -= frame.length
    this.last = frame[frame.length - 1] ?? this.last
    return Float32Array.from(out)
  }
}

const toPcm16 = (f: Float32Array) => Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))))
const rms = (f: Float32Array) => Math.sqrt(f.reduce((n, v) => n + v * v, 0) / Math.max(1, f.length))

export class AvatarLayer {
  private socket: AvatarSocket | null = null
  private room: { leave(): void } | null = null
  private tapHandle: { stop(): void } | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  private keepAlive: ReturnType<typeof setInterval> | null = null
  private resampler = new Resampler()
  private pending: Int16Array[] = []
  private pendingSamples = 0
  private utterance: string | null = null
  /** Whether the next chunk is the utterance's first (it must carry the utterance id). */
  private first = false
  private silentMs = 0
  private talking = false
  private done = false
  private deadline = 0
  private readonly events: AvatarLayerEvents
  private readonly deps: AvatarDeps

  constructor(events: AvatarLayerEvents, deps: AvatarDeps) {
    this.events = events
    this.deps = deps
  }

  async start(grant: AvatarGrant, voiceStream: MediaStream, media: AvatarMedia): Promise<void> {
    this.deadline = Date.parse(grant.deadlineAt)
    try {
      this.room = await this.deps.joinRoom(grant.livekitUrl, grant.livekitClientToken, media, () => this.fail('room_disconnected'))
    } catch {
      this.fail('start_failed')
      return
    }
    if (this.done) return
    const socket = this.deps.openSocket(grant.wsUrl)
    this.socket = socket
    const connected = new Promise<boolean>((resolve) => {
      this.timers.push(setTimeout(() => resolve(false), CONNECT_TIMEOUT_MS))
      socket.onmessage = (event) => {
        const e = this.parse(event.data)
        if (e?.type === 'session.state_updated' && e.state === 'connected') resolve(true)
        this.handle(e)
      }
    })
    socket.onclose = () => this.fail(this.deps.now() >= this.deadline - 5_000 ? 'time_limit' : 'socket_closed')
    socket.onerror = () => this.fail('socket_closed')
    if (!(await connected)) return this.fail('start_failed')
    if (this.done) return
    try {
      this.tapHandle = await this.deps.tap(voiceStream, (frame, rate) => this.onFrame(frame, rate))
    } catch {
      return this.fail('start_failed')
    }
    if (this.done) return
    this.keepAlive = setInterval(() => this.send({ type: 'session.keep_alive', event_id: uuid() }), KEEP_ALIVE_MS)
    this.events.onReady()
  }

  /** Student speech (from the voice session): drop whatever the avatar is still saying. */
  interrupt(): void {
    if (this.done || (!this.utterance && !this.talking)) return
    this.utterance = null
    this.pending = []
    this.pendingSamples = 0
    this.silentMs = 0
    this.send({ type: 'agent.interrupt', event_id: uuid() })
  }

  /** Tears down without reporting a failure (End session, Stop avatar, leaving the page). */
  stop(): void {
    this.done = true
    this.teardown()
  }

  private fail(reason: AvatarFailure) {
    if (this.done) return
    this.done = true
    this.teardown()
    this.events.onFailure(reason)
  }

  private teardown() {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    this.tapHandle?.stop()
    this.tapHandle = null
    if (this.socket) {
      this.socket.onmessage = this.socket.onclose = this.socket.onerror = null
      try {
        this.socket.close()
      } catch {
        /* already closed */
      }
    }
    this.socket = null
    this.room?.leave()
    this.room = null
  }

  private parse(raw: unknown): { type?: string; [k: string]: unknown } | null {
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  private handle(e: { type?: string; [k: string]: unknown } | null) {
    if (!e) return
    if (e.type === 'agent.state_updated') this.talking = e.new_state === 'talking'
    else if (e.type === 'error') this.fail('provider_error')
    else if (e.type === 'session.state_updated' && (e.state === 'disconnected' || e.state === 'closed')) this.fail('socket_closed')
  }

  private send(payload: Record<string, unknown>) {
    try {
      this.socket?.send(JSON.stringify(payload))
    } catch {
      this.fail('socket_closed')
    }
  }

  private onFrame(frame: Float32Array, rate: number) {
    if (this.done) return
    const samples = this.resampler.push(frame, rate)
    if (samples.length === 0) return
    const loud = rms(samples) >= SPEECH_RMS
    if (!this.utterance) {
      if (!loud) return
      this.utterance = uuid()
      this.first = true
      this.silentMs = 0
    }
    this.pending.push(toPcm16(samples))
    this.pendingSamples += samples.length
    this.silentMs = loud ? 0 : this.silentMs + (samples.length / AVATAR_RATE) * 1000
    if (this.silentMs >= SILENCE_END_MS) {
      this.flush('agent.speak_end')
      this.utterance = null
    } else if (this.pendingSamples >= CHUNK_SAMPLES) {
      this.flush('agent.speak')
    }
  }

  private flush(type: 'agent.speak' | 'agent.speak_end') {
    const audio = new Int16Array(this.pendingSamples)
    let at = 0
    for (const p of this.pending) {
      audio.set(p, at)
      at += p.length
    }
    this.pending = []
    this.pendingSamples = 0
    // The first chunk of an utterance carries the utterance's id; later chunks use their own.
    const id = this.first && this.utterance ? this.utterance : uuid()
    this.first = false
    this.send({ type, event_id: id, ...(audio.length ? { audio: toBase64(audio) } : {}) })
  }
}
