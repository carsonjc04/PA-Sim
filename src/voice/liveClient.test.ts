// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveVoiceClient } from './liveClient'
import type { VoiceClientEvents, VoiceConnectionState } from './types'

class FakeTrack {
  enabled = true
  stopped = false
  kind = 'audio'
  stop() {
    this.stopped = true
  }
}

class FakeStream {
  tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks
  }
}

class FakeDataChannel {
  readyState = 'open'
  label: string
  closed = false
  sent: unknown[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  private listeners: ((e: MessageEvent) => void)[] = []

  constructor(label: string) {
    this.label = label
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
    this.readyState = 'closed'
  }
  addEventListener(_type: string, fn: (e: MessageEvent) => void) {
    this.listeners.push(fn)
  }
  removeEventListener(_type: string, fn: (e: MessageEvent) => void) {
    this.listeners = this.listeners.filter((l) => l !== fn)
  }
  deliver(payload: unknown) {
    const data = JSON.stringify(payload)
    this.onmessage?.({ data })
    for (const l of [...this.listeners]) l({ data } as MessageEvent)
  }
}

class FakePeerConnection {
  static last: FakePeerConnection | null = null
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  remoteDescription: { type: string; sdp: string } | null = null
  channel: FakeDataChannel | null = null
  closed = false
  addedTracks: FakeTrack[] = []
  ontrack: ((e: { streams: unknown[] }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null

  constructor() {
    FakePeerConnection.last = this
  }
  addTrack(track: FakeTrack) {
    this.addedTracks.push(track)
  }
  createDataChannel(label: string) {
    this.channel = new FakeDataChannel(label)
    return this.channel
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\noffer\r\n' }
  }
  async setLocalDescription(desc: { sdp: string }) {
    this.localDescription = desc
  }
  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true
  }
}

function harness() {
  const states: VoiceConnectionState[] = []
  const events: VoiceClientEvents = {
    onStateChange: (s) => states.push(s),
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onUsage: vi.fn(),
    onPatientSpeakingChange: vi.fn(),
  }
  return { states, events, client: new LiveVoiceClient(events) }
}

const start = (client: LiveVoiceClient) =>
  client.start({ encounterId: 'enc-1', apiBaseUrl: 'http://localhost:8787' })

let micTracks: FakeTrack[]

beforeEach(() => {
  micTracks = [new FakeTrack()]
  FakePeerConnection.last = null
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(new FakeStream(micTracks)) },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'live_sess_1', sdp: 'v=0\r\nanswer\r\n' }),
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('voice connection lifecycle', () => {
  it('creates the oai-events channel before the offer and waits for session.started', async () => {
    const { client, states } = harness()
    const pending = start(client)

    // Give the connect sequence a turn to reach the SDP exchange.
    await vi.waitFor(() => expect(FakePeerConnection.last?.remoteDescription).toBeTruthy())
    const peer = FakePeerConnection.last!

    expect(peer.channel?.label).toBe('oai-events')
    expect(peer.addedTracks).toHaveLength(1)
    expect(peer.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\nanswer\r\n' })
    // Not live yet: session.started has not arrived.
    expect(states).not.toContain('live')

    peer.channel!.deliver({ type: 'session.started', event_id: 'e1' })
    await pending

    expect(states).toEqual(['requesting-microphone', 'connecting', 'live'])
    expect(client.getSessionId()).toBe('live_sess_1')
  })

  it('reports a denied microphone as recoverable and never opens a connection', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(denied) },
    })
    const { client, events } = harness()

    await expect(start(client)).rejects.toThrow()
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'microphone_denied', recoverable: true }),
    )
    expect(FakePeerConnection.last).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('surfaces a missing server key as a non-recoverable setup problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: { code: 'missing_api_key', message: 'Set OPENAI_API_KEY' } }),
      }),
    )
    const { client, events } = harness()

    await expect(start(client)).rejects.toThrow()
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'missing_api_key', recoverable: false }),
    )
  })

  it('aggregates transcript deltas from both speakers', async () => {
    const { client, events } = harness()
    const pending = start(client)
    await vi.waitFor(() => expect(FakePeerConnection.last?.channel).toBeTruthy())
    const channel = FakePeerConnection.last!.channel!
    channel.deliver({ type: 'session.started', event_id: 'e1' })
    await pending

    channel.deliver({
      type: 'session.input_transcript.delta',
      delta: 'Any chest pain?',
      start_ms: 0,
      end_ms: 500,
      event_id: 'e2',
    })
    channel.deliver({
      type: 'session.output_transcript.delta',
      delta: 'Yes, it is heavy.',
      start_ms: 600,
      end_ms: 1200,
      event_id: 'e3',
    })

    const latest = (events.onTranscript as ReturnType<typeof vi.fn>).mock.lastCall![0]
    expect(latest.map((s: { speaker: string; text: string }) => [s.speaker, s.text])).toEqual([
      ['student', 'Any chest pain?'],
      ['patient', 'Yes, it is heavy.'],
    ])
    expect(events.onPatientSpeakingChange).toHaveBeenCalledWith(true)
  })

  it('relays a delegated function call and requests a response afterwards', async () => {
    const { client } = harness()
    const pending = start(client)
    await vi.waitFor(() => expect(FakePeerConnection.last?.channel).toBeTruthy())
    const channel = FakePeerConnection.last!.channel!
    channel.deliver({ type: 'session.started', event_id: 'e1' })
    await pending

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ callId: 'call_1', output: { ok: true, findings: [] } }),
      }),
    )

    channel.deliver({
      type: 'response.event',
      event_id: 'e4',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'record_history_topics',
          arguments: '{"actionIds":["onset"]}',
        },
      },
    })

    await vi.waitFor(() => expect(channel.sent).toHaveLength(2))
    const [output, create] = channel.sent as { type: string; item?: { call_id: string } }[]
    expect(output.type).toBe('response.item.create')
    expect(output.item?.call_id).toBe('call_1')
    expect(create.type).toBe('response.create')
  })

  it('mutes by disabling the track without closing the billed session', async () => {
    const { client } = harness()
    const pending = start(client)
    await vi.waitFor(() => expect(FakePeerConnection.last?.channel).toBeTruthy())
    FakePeerConnection.last!.channel!.deliver({ type: 'session.started', event_id: 'e1' })
    await pending

    client.setMuted(true)
    expect(micTracks[0].enabled).toBe(false)
    expect(micTracks[0].stopped).toBe(false)
    expect(client.getState()).toBe('live')

    client.setMuted(false)
    expect(micTracks[0].enabled).toBe(true)
  })

  it('closes cleanly: acknowledges, then releases peer, channel and microphone', async () => {
    const { client, states } = harness()
    const pending = start(client)
    await vi.waitFor(() => expect(FakePeerConnection.last?.channel).toBeTruthy())
    const peer = FakePeerConnection.last!
    peer.channel!.deliver({ type: 'session.started', event_id: 'e1' })
    await pending

    const stopping = client.stop()
    await vi.waitFor(() =>
      expect(peer.channel!.sent.some((m) => (m as { type: string }).type === 'session.close')).toBe(
        true,
      ),
    )
    peer.channel!.deliver({ type: 'session.closed', event_id: 'e5' })
    await stopping

    expect(peer.closed).toBe(true)
    expect(micTracks[0].stopped).toBe(true)
    expect(states).toContain('closing')
    expect(client.getState()).toBe('closed')
  })

  it('finishes cleanup even when the close acknowledgement never arrives', async () => {
    vi.useFakeTimers()
    try {
      const { client } = harness()
      const pending = start(client)
      await vi.waitFor(() => expect(FakePeerConnection.last?.channel).toBeTruthy())
      const peer = FakePeerConnection.last!
      peer.channel!.deliver({ type: 'session.started', event_id: 'e1' })
      await pending

      const stopping = client.stop()
      await vi.advanceTimersByTimeAsync(2000)
      await stopping

      expect(peer.closed).toBe(true)
      expect(micTracks[0].stopped).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
