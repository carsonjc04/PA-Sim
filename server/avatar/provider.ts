import { env } from '../config/env'

/**
 * LiveAvatar LITE over its REST API (https://docs.liveavatar.com). The API key stays here; the browser gets
 * only the started session's LiveKit room token and its event socket URL, both scoped to that one session.
 */

export interface AvatarSessionGrant {
  avatarSessionId: string
  livekitUrl: string
  livekitClientToken: string
  wsUrl: string
  /** Seconds the provider will run this session before ending it itself. */
  maxSeconds: number
}

export interface AvatarProvider {
  start(input: { avatarId: string; sandbox: boolean; maxSeconds: number }): Promise<AvatarSessionGrant>
  /** Resolves true when the provider accepted the stop (or the session is already gone). */
  stop(avatarSessionId: string): Promise<boolean>
  /** Credits the provider billed for the session, or null if it has not said yet. */
  credits(avatarSessionId: string): Promise<number | null>
}

const API = 'https://api.liveavatar.com'
const TIMEOUT_MS = 10_000
// Starting has been observed to take over 15 s; the session can come up and bill even when the call times out.
const START_TIMEOUT_MS = 30_000

export class AvatarProviderError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown; bearer?: string; timeoutMs?: number }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`
  else headers['X-API-KEY'] = env.LIVEAVATAR_API_KEY ?? ''
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
  })
  const json = (await response.json().catch(() => null)) as { code?: number; data?: T; message?: string } | null
  // The provider reports success as code 1000 inside a 2xx body; anything else is a refusal.
  if (!response.ok || !json || json.code !== 1000) {
    // Only the status crosses into logs and errors: provider messages can echo request details.
    throw new AvatarProviderError('LiveAvatar refused the request', response.ok ? 502 : response.status)
  }
  return json.data as T
}

export const liveAvatarProvider: AvatarProvider = {
  async start({ avatarId, sandbox, maxSeconds }) {
    const token = await call<{ session_id: string; session_token: string }>('/v1/sessions/token', {
      body: { mode: 'LITE', avatar_id: avatarId, is_sandbox: sandbox, max_session_duration: maxSeconds },
    })
    let started: { session_id: string; livekit_url: string; livekit_client_token: string; ws_url?: string; max_session_duration?: number }
    try {
      started = await call('/v1/sessions/start', { bearer: token.session_token, timeoutMs: START_TIMEOUT_MS })
      if (!started.ws_url) throw new AvatarProviderError('LiveAvatar started a session without an event socket', 502)
    } catch (cause) {
      // A failed or timed-out start may still have started a billed session: stop it by the token's session ID.
      void liveAvatarProvider.stop(token.session_id).catch(() => console.error('[avatar] could not stop a failed start; its provider maximum ends it'))
      throw cause
    }
    return {
      avatarSessionId: started.session_id,
      livekitUrl: started.livekit_url,
      livekitClientToken: started.livekit_client_token,
      wsUrl: started.ws_url,
      maxSeconds: started.max_session_duration ?? maxSeconds,
    }
  },
  async stop(avatarSessionId) {
    await call('/v1/sessions/stop', { body: { session_id: avatarSessionId, reason: 'USER_CLOSED' } })
    return true
  },
  async credits(avatarSessionId) {
    const data = await call<{ credits_consumed?: number; end_at?: string | null } | null>(`/v1/sessions/${avatarSessionId}`, { method: 'GET' })
    return typeof data?.credits_consumed === 'number' && data.end_at ? data.credits_consumed : null
  },
}

let provider: AvatarProvider = liveAvatarProvider
export const avatarProvider = () => provider
/** Test seam. */
export function setAvatarProvider(next: AvatarProvider | null): void {
  provider = next ?? liveAvatarProvider
}
