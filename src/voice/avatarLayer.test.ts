import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AVATAR_RATE, AvatarLayer, Resampler, type AvatarDeps, type AvatarSocket } from './avatarLayer'

const grant = (deadlineInMs = 120_000) => ({ avatarSessionId: 'av1', livekitUrl: 'wss://lk', livekitClientToken: 't', wsUrl: 'wss://ws', deadlineAt: new Date(Date.now() + deadlineInMs).toISOString() })
const media = { video: {} as HTMLVideoElement, audio: {} as HTMLAudioElement }

function rig(opts: { roomFails?: boolean } = {}) {
  const sent: { type: string; event_id: string; audio?: string }[] = []
  const socket: AvatarSocket = { send: (d) => void sent.push(JSON.parse(d)), close: vi.fn(), onmessage: null, onclose: null, onerror: null }
  let frame: ((f: Float32Array, rate: number) => void) | null = null
  let roomDown: (() => void) | null = null
  const left = vi.fn()
  const tapStop = vi.fn()
  const deps: AvatarDeps = {
    openSocket: () => socket,
    joinRoom: async (_u, _t, _m, onDisconnected) => {
      if (opts.roomFails) throw new Error('no room')
      roomDown = onDisconnected
      return { leave: left }
    },
    tap: async (_s, onFrame) => {
      frame = onFrame
      return { stop: tapStop }
    },
    now: () => Date.now(),
  }
  const events = { onReady: vi.fn(), onFailure: vi.fn() }
  const layer = new AvatarLayer(events, deps)
  const emit = (e: object) => socket.onmessage?.({ data: JSON.stringify(e) })
  return {
    layer,
    events,
    sent,
    socket,
    left,
    tapStop,
    emit,
    roomDown: () => roomDown?.(),
    /** `ms` of 24 kHz audio, loud or silent. */
    audio: (ms: number, loud: boolean) => frame?.(new Float32Array((AVATAR_RATE * ms) / 1000).fill(loud ? 0.2 : 0), AVATAR_RATE),
  }
}

async function started(r: ReturnType<typeof rig>, g = grant()) {
  const p = r.layer.start(g, {} as MediaStream, media)
  await vi.waitFor(() => expect(r.socket.onmessage).not.toBeNull())
  r.emit({ type: 'session.state_updated', state: 'connected' })
  await p
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.useRealTimers())

describe('utterance framing', () => {
  it('streams voice audio with a 500 ms lead then 200 ms chunks, the first carrying the utterance id, and ends on silence', async () => {
    const r = rig()
    await started(r)
    expect(r.events.onReady).toHaveBeenCalledOnce()
    r.audio(100, false) // quiet before speech is not sent
    expect(r.sent).toEqual([])
    r.audio(200, true)
    r.audio(200, true)
    expect(r.sent).toEqual([]) // still building the lead
    r.audio(200, true)
    r.audio(200, true)
    r.audio(700, false)
    const speaks = r.sent.filter((e) => e.type === 'agent.speak')
    expect(speaks.length).toBeGreaterThanOrEqual(2)
    expect(r.sent.at(-1)?.type).toBe('agent.speak_end')
    expect(new Set(r.sent.map((e) => e.event_id)).size).toBe(r.sent.length)
    // 600 ms of PCM16 at 24 kHz (the lead, reached on the third frame) is 28800 bytes; later chunks 200 ms, 9600 bytes.
    expect(atob(speaks[0].audio!).length).toBe(28800)
    expect(atob(speaks[1].audio!).length).toBe(9600)

    // The next utterance starts with a new id.
    const firstId = speaks[0].event_id
    r.audio(600, true)
    const next = r.sent.at(-1)!
    expect(next.type).toBe('agent.speak')
    expect(next.event_id).not.toBe(firstId)
  })
})

describe('barge-in', () => {
  it('interrupts only while the avatar is speaking or has audio queued', async () => {
    const r = rig()
    await started(r)
    r.layer.interrupt()
    expect(r.sent).toEqual([])
    r.audio(200, true)
    r.layer.interrupt()
    expect(r.sent.at(-1)?.type).toBe('agent.interrupt')
    r.layer.interrupt() // more student speech: nothing left to interrupt
    expect(r.sent.filter((e) => e.type === 'agent.interrupt')).toHaveLength(1)
    r.emit({ type: 'agent.state_updated', new_state: 'talking' })
    r.layer.interrupt()
    expect(r.sent.filter((e) => e.type === 'agent.interrupt')).toHaveLength(2)
  })
})

describe('failure reporting', () => {
  it.each([
    ['the event socket closes', (r: ReturnType<typeof rig>) => r.socket.onclose?.(), 'socket_closed'],
    ['the provider reports an error', (r: ReturnType<typeof rig>) => r.emit({ type: 'error', error: { type: 'video_starvation' } }), 'provider_error'],
    ['the LiveKit room drops', (r: ReturnType<typeof rig>) => r.roomDown(), 'room_disconnected'],
  ] as const)('reports once and tears down when %s', async (_name, trigger, reason) => {
    const r = rig()
    await started(r)
    trigger(r)
    trigger(r)
    expect(r.events.onFailure).toHaveBeenCalledTimes(1)
    expect(r.events.onFailure).toHaveBeenCalledWith(reason)
    expect(r.tapStop).toHaveBeenCalled()
    expect(r.left).toHaveBeenCalled()
  })

  it('calls the provider ending its session at the deadline a time limit', async () => {
    const r = rig()
    await started(r, grant(2_000))
    r.socket.onclose?.()
    expect(r.events.onFailure).toHaveBeenCalledWith('time_limit')
  })

  it('reports a start failure when the room cannot be joined', async () => {
    const r = rig({ roomFails: true })
    await r.layer.start(grant(), {} as MediaStream, media)
    expect(r.events.onFailure).toHaveBeenCalledWith('start_failed')
    expect(r.events.onReady).not.toHaveBeenCalled()
  })

  it('reports a start failure when the avatar never connects', async () => {
    vi.useFakeTimers()
    const r = rig()
    const p = r.layer.start(grant(), {} as MediaStream, media)
    await vi.advanceTimersByTimeAsync(16_000)
    await p
    expect(r.events.onFailure).toHaveBeenCalledWith('start_failed')
  })

  it('a deliberate stop reports nothing', async () => {
    const r = rig()
    await started(r)
    r.layer.stop()
    r.socket.onclose?.()
    expect(r.events.onFailure).not.toHaveBeenCalled()
    expect(r.left).toHaveBeenCalled()
  })
})

describe('resampling to 24 kHz', () => {
  it('keeps duration across frames at 48 kHz and 44.1 kHz', () => {
    for (const rate of [48_000, 44_100]) {
      const r = new Resampler()
      let out = 0
      for (let i = 0; i < 100; i += 1) out += r.push(new Float32Array(128).fill(0.1), rate).length
      expect(Math.abs(out - (100 * 128 * AVATAR_RATE) / rate)).toBeLessThanOrEqual(1)
    }
  })
})
