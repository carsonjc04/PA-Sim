// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceClientEvents } from './types'
import type { AvatarLayerEvents } from './avatarLayer'
import { setAvatarLoader, useVoiceEncounter } from './useVoiceEncounter'

const captured = vi.hoisted(() => ({ events: null as VoiceClientEvents | null, remoteMuted: [] as boolean[], stopped: 0 }))
vi.mock('./liveClient', () => ({
  LiveVoiceClient: class {
    constructor(events: VoiceClientEvents) {
      captured.events = events
    }
    start = () => Promise.resolve()
    stop = () => {
      captured.stopped += 1
      return Promise.resolve()
    }
    getDeadline = () => null
    getSessionId = () => 'live_sess_1'
    getRemoteStream = () => ({}) as MediaStream
    setRemoteAudioMuted = (m: boolean) => void captured.remoteMuted.push(m)
  },
}))
vi.mock('../api/client', () => ({ apiBaseUrl: '', authHeaders: () => ({}) }))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('voice presence', () => {
  it('moves idle → listening → thinking → speaking → idle from speech events', () => {
    const { result } = renderHook(() => useVoiceEncounter('a'))
    expect(result.current.presence).toBe('idle')
    act(() => result.current.connect())
    const events = captured.events!
    act(() => events.onStateChange('live'))
    expect(result.current.presence).toBe('idle')
    act(() => events.onStudentSpeech?.())
    expect(result.current.presence).toBe('listening')
    act(() => void vi.advanceTimersByTime(1_000))
    expect(result.current.presence).toBe('thinking')
    act(() => events.onPatientSpeakingChange(true))
    expect(result.current.presence).toBe('speaking')
    act(() => events.onPatientSpeakingChange(false))
    expect(result.current.presence).toBe('idle')
  })

  it('stops thinking when no reply comes, and is idle when not live', () => {
    const { result } = renderHook(() => useVoiceEncounter('a'))
    act(() => result.current.connect())
    const events = captured.events!
    act(() => events.onStateChange('live'))
    act(() => events.onStudentSpeech?.())
    act(() => void vi.advanceTimersByTime(9_000))
    expect(result.current.presence).toBe('idle')
    act(() => events.onStudentSpeech?.())
    act(() => events.onStateChange('closed'))
    expect(result.current.presence).toBe('idle')
  })
})

describe('avatar layer over voice', () => {
  const grant = { avatarSessionId: 'av1', livekitUrl: 'wss://lk', livekitClientToken: 't', wsUrl: 'wss://ws', deadlineAt: new Date(Date.now() + 120_000).toISOString() }
  let layerEvents: AvatarLayerEvents | null
  let layer: { start: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
  let fetches: { url: string; body: Record<string, unknown> }[]
  const media = () => ({ video: {} as HTMLVideoElement, audio: {} as HTMLAudioElement })

  beforeEach(() => {
    vi.useRealTimers()
    captured.remoteMuted = []
    captured.stopped = 0
    layerEvents = null
    fetches = []
    layer = { start: vi.fn().mockResolvedValue(undefined), interrupt: vi.fn(), stop: vi.fn() }
    setAvatarLoader(async (events) => {
      layerEvents = events
      return layer as never
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      fetches.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify(url.endsWith('/api/live/avatar') ? grant : { ok: true }), { status: 200 })
    }))
  })
  afterEach(() => {
    setAvatarLoader(null)
    vi.unstubAllGlobals()
  })

  async function liveWithAvatar() {
    const hook = renderHook(() => useVoiceEncounter('a', undefined, media))
    act(() => hook.result.current.connect('avatar'))
    act(() => captured.events!.onStateChange('live'))
    await vi.waitFor(() => expect(layer.start).toHaveBeenCalled())
    act(() => layerEvents!.onReady())
    return hook
  }

  it('requests the avatar only after voice is live, and plays it instead of the Realtime audio', async () => {
    const { result } = await liveWithAvatar()
    expect(fetches[0].url).toBe('/api/live/avatar')
    expect(fetches[0].body).toEqual({ attemptId: 'a', sessionId: 'live_sess_1' })
    expect(result.current.avatar).toBe('live')
    expect(captured.remoteMuted).toEqual([true])
  })

  it('lets voice own barge-in: student speech interrupts the avatar', async () => {
    await liveWithAvatar()
    act(() => captured.events!.onStudentSpeech?.())
    expect(layer.interrupt).toHaveBeenCalledTimes(1)
  })

  it('degrades to voice-only on failure: unmutes voice, keeps the session and the transcript, tells the server', async () => {
    const { result } = await liveWithAvatar()
    const segments = [{ id: 's1', speaker: 'patient' as const, text: 'It started an hour ago.', startMs: 0, endMs: 1 }]
    act(() => captured.events!.onTranscript(segments))
    act(() => layerEvents!.onFailure('socket_closed'))
    expect(captured.remoteMuted).toEqual([true, false])
    expect(result.current.avatar).toBe('ended')
    expect(result.current.avatarNotice).toMatch(/continues as voice only\. Your transcript and progress are unchanged\./)
    expect(result.current.state).toBe('live')
    expect(result.current.transcript).toEqual(segments)
    expect(captured.stopped).toBe(0)
    await vi.waitFor(() => expect(fetches.at(-1)).toEqual({ url: '/api/live/avatar/end', body: { attemptId: 'a', sessionId: 'live_sess_1', reason: 'failed' } }))
    // A late failure from the dead layer changes nothing.
    act(() => captured.events!.onStudentSpeech?.())
    expect(layer.interrupt).not.toHaveBeenCalled()
  })

  it('stays voice-only when the server refuses the avatar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'The avatar could not start. Voice continues without it.' } }), { status: 502 })))
    const { result } = renderHook(() => useVoiceEncounter('a', undefined, media))
    act(() => result.current.connect('avatar'))
    act(() => captured.events!.onStateChange('live'))
    await vi.waitFor(() => expect(result.current.avatar).toBe('ended'))
    expect(result.current.avatarNotice).toMatch(/could not start/)
    expect(layer.start).not.toHaveBeenCalled()
    expect(captured.remoteMuted).toEqual([])
    expect(result.current.state).toBe('live')
  })

  it('never starts an avatar in voice-only mode', async () => {
    const { result } = renderHook(() => useVoiceEncounter('a', undefined, media))
    act(() => result.current.connect())
    act(() => captured.events!.onStateChange('live'))
    await Promise.resolve()
    expect(fetches).toEqual([])
    expect(result.current.avatar).toBe('off')
  })
})
