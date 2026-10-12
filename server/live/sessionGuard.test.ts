import { afterEach, describe, expect, it, vi } from 'vitest'

// A stand-in for the SDK's sideband socket: records what is sent and lets the test emit events.
const sockets = vi.hoisted(() => [] as FakeSideband[])
class FakeSideband {
  sent: unknown[] = []
  closed = false
  handlers: Record<string, ((e: unknown) => void)[]> = {}
  params: { session_id: string }
  constructor(_client: unknown, params: { session_id: string }) {
    this.params = params
    sockets.push(this)
  }
  on(event: string, fn: (e: unknown) => void) {
    ;(this.handlers[event] ??= []).push(fn)
  }
  emit(event: string, payload: unknown = {}) {
    for (const fn of this.handlers[event] ?? []) fn(payload)
  }
  send(e: unknown) {
    this.sent.push(e)
  }
  close() {
    this.closed = true
  }
}
vi.mock('openai/resources/live/sideband/ws', () => ({ SidebandWS: FakeSideband }))
vi.mock('../openai/client', () => ({ openaiClient: () => ({}) }))

const { sidebandCloser } = await import('./sessionGuard')

afterEach(() => {
  sockets.length = 0
  vi.useRealTimers()
})

describe('sideband closer', () => {
  it('attaches to the session, sends session.close and resolves when the session reports closed', async () => {
    const done = sidebandCloser.close('live_sess_abc')
    const ws = sockets[0]
    expect(ws.params).toEqual({ session_id: 'live_sess_abc' })
    expect(ws.sent).toEqual([{ type: 'session.close' }])
    ws.emit('session.closed', { reason: 'close_requested' })
    await expect(done).resolves.toBeUndefined()
    expect(ws.closed).toBe(true)
  })

  it('rejects on a socket error so a later check retries', async () => {
    const done = sidebandCloser.close('live_sess_err')
    sockets[0].emit('error', new Error('401'))
    await expect(done).rejects.toThrow('401')
    expect(sockets[0].closed).toBe(true)
  })

  it('gives up waiting after a bounded time instead of hanging', async () => {
    vi.useFakeTimers()
    const done = sidebandCloser.close('live_sess_slow')
    await vi.advanceTimersByTimeAsync(5_001)
    await expect(done).resolves.toBeUndefined()
    expect(sockets[0].closed).toBe(true)
  })
})
