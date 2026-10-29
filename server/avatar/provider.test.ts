import { afterEach, describe, expect, it, vi } from 'vitest'

describe('LiveAvatar provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    delete process.env.LIVEAVATAR_API_KEY
  })

  async function provider(start: () => Promise<Response>) {
    process.env.LIVEAVATAR_API_KEY = 'la-test-not-a-real-key'
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null, headers: init.headers as Record<string, string> })
      if (url.endsWith('/v1/sessions/token')) return new Response(JSON.stringify({ code: 1000, data: { session_id: 'sess-1', session_token: 'jwt' } }))
      if (url.endsWith('/v1/sessions/start')) return start()
      return new Response(JSON.stringify({ code: 1000, data: null }))
    }))
    const { liveAvatarProvider } = await import('./provider')
    return { p: liveAvatarProvider, calls }
  }

  it('mints a LITE session capped at the requested duration, authenticating start with the session token only', async () => {
    const { p, calls } = await provider(async () => new Response(JSON.stringify({ code: 1000, data: { session_id: 'sess-1', livekit_url: 'wss://lk', livekit_client_token: 'c', ws_url: 'wss://ws', max_session_duration: 90 } })))
    const grant = await p.start({ avatarId: 'a', sandbox: false, maxSeconds: 90 })
    expect(grant).toEqual({ avatarSessionId: 'sess-1', livekitUrl: 'wss://lk', livekitClientToken: 'c', wsUrl: 'wss://ws', maxSeconds: 90 })
    expect(calls[0].body).toEqual({ mode: 'LITE', avatar_id: 'a', is_sandbox: false, max_session_duration: 90 })
    expect(calls[1].headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer jwt' })
  })

  it('stops the token’s session when start fails or times out, since it may still be billing', async () => {
    const { p, calls } = await provider(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    await expect(p.start({ avatarId: 'a', sandbox: false, maxSeconds: 90 })).rejects.toThrow()
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ url: 'https://api.liveavatar.com/v1/sessions/stop', body: { session_id: 'sess-1' } }))
    expect(calls.at(-1)!.headers['X-API-KEY']).toBe('la-test-not-a-real-key')
  })

  it('treats a start without an event socket as a failure and stops it', async () => {
    const { p, calls } = await provider(async () => new Response(JSON.stringify({ code: 1000, data: { session_id: 'sess-1', livekit_url: 'wss://lk', livekit_client_token: 'c' } })))
    await expect(p.start({ avatarId: 'a', sandbox: false, maxSeconds: 90 })).rejects.toThrow(/event socket/)
    await vi.waitFor(() => expect(calls.at(-1)?.url).toMatch(/sessions\/stop$/))
  })
})
