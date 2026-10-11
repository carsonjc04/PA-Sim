// Browser HTTP client. Holds no scenario data and no grading logic; the server is the source of truth.
import type {
  ApiErrorBody,
  ApiErrorCode,
  AttemptEventBody,
  AttemptRemediation,
  AuthStatus,
  EventResponse,
  HistoryPage,
  PublicAttempt,
  PublicScenario,
  ReviewEventBody,
  ReviewMode,
  ReviewSessionResponse,
  ReviewSummary,
  StartAttemptResponse,
  SubmitReviewBody,
  SubmitReviewResponse,
} from './contracts'

export const apiBaseUrl: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787'
const DEV_USER_KEY = 'clinicsim-dev-user'
const RETRIES = 2

export class ApiRequestError extends Error {
  status: number
  code: ApiErrorCode | 'network'

  constructor(message: string, status: number, code: ApiErrorCode | 'network') {
    super(message)
    this.status = status
    this.code = code
  }
}

export function getDevUser(): string | null {
  try {
    return localStorage.getItem(DEV_USER_KEY)
  } catch {
    return null
  }
}

export function setDevUser(user: string | null): void {
  try {
    if (user) localStorage.setItem(DEV_USER_KEY, user)
    else localStorage.removeItem(DEV_USER_KEY)
  } catch {
    /* storage unavailable: identity lasts for this page only */
  }
  window.dispatchEvent(new Event('clinicsim-dev-user'))
}

/** Headers that identify the current user to the server. */
export function authHeaders(): Record<string, string> {
  const user = getDevUser()
  return user ? { 'X-Dev-User': user } : {}
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

async function request<T>(path: string, init: RequestInit & { idempotencyKey?: string; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() }
  if (init.body) headers['Content-Type'] = 'application/json'
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey

  // Only idempotent requests are retried, and always with the same key.
  const attempts = init.retry ? RETRIES + 1 : 1
  let lastError: ApiRequestError | null = null
  for (let i = 0; i < attempts; i += 1) {
    let response: Response
    try {
      response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers })
    } catch {
      lastError = new ApiRequestError('Could not reach the ClinicSim server.', 0, 'network')
      continue
    }
    const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null
    if (response.ok) return body as T
    const error = (body as ApiErrorBody | null)?.error
    lastError = new ApiRequestError(error?.message ?? 'The request failed.', response.status, error?.code ?? 'internal_error')
    if (response.status < 500) break
  }
  throw lastError!
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  scenarios: () => request<PublicScenario[]>('/api/scenarios', { retry: true }),
  startAttempt: (scenarioId: string) =>
    request<StartAttemptResponse>('/api/attempts', { method: 'POST', body: JSON.stringify({ scenarioId }), retry: true }),
  attempt: (id: string) => request<PublicAttempt>(`/api/attempts/${encodeURIComponent(id)}`, { retry: true }),
  history: (params: { cursor?: string; limit?: number; status?: 'active' | 'submitted' } = {}) => {
    const query = new URLSearchParams()
    if (params.limit) query.set('limit', String(params.limit))
    if (params.cursor) query.set('cursor', params.cursor)
    if (params.status) query.set('status', params.status)
    const qs = query.toString()
    return request<HistoryPage>(`/api/attempts${qs ? `?${qs}` : ''}`, { retry: true })
  },
  event: (attemptId: string, body: AttemptEventBody, idempotencyKey = newKey()) =>
    request<EventResponse>(`/api/attempts/${encodeURIComponent(attemptId)}/events`, {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey,
      retry: true,
    }),
  // Submit is idempotent by attempt state, so retrying it is safe.
  submit: (attemptId: string) =>
    request<PublicAttempt>(`/api/attempts/${encodeURIComponent(attemptId)}/submit`, { method: 'POST', retry: true }),
  remediation: (attemptId: string) =>
    request<AttemptRemediation>(`/api/attempts/${encodeURIComponent(attemptId)}/remediation?timeZone=${encodeURIComponent(browserTimeZone())}`, { retry: true }),
  reviewSummary: () => request<ReviewSummary>(`/api/review/summary?timeZone=${encodeURIComponent(browserTimeZone())}`, { retry: true }),
  currentReview: () => request<ReviewSessionResponse>(`/api/review/sessions/current?timeZone=${encodeURIComponent(browserTimeZone())}`, { retry: true }),
  // Starting resumes today's open session, so a retry cannot create a second one.
  startReview: (mode: ReviewMode, restart = false) =>
    request<ReviewSessionResponse>('/api/review/sessions', {
      method: 'POST',
      body: JSON.stringify({ mode, timeZone: browserTimeZone(), ...(restart ? { restart } : {}) }),
      retry: true,
    }),
  rateReview: (cardId: string, body: SubmitReviewBody, idempotencyKey = newKey()) =>
    request<SubmitReviewResponse>(`/api/review/cards/${encodeURIComponent(cardId)}/reviews`, {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey,
      retry: true,
    }),
  reviewEvent: (sessionId: string, body: ReviewEventBody) =>
    request<{ ok: true }>(`/api/review/sessions/${encodeURIComponent(sessionId)}/events`, { method: 'POST', body: JSON.stringify(body), retry: true }),
}

/** The browser's IANA zone; the server uses it for the 04:00 local study-day boundary. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Old unauthenticated, browser-graded history. Never imported; only offered for deletion. */
export const LEGACY_ATTEMPTS_KEY = 'clinicsim-attempts-v1'

export function hasLegacyAttempts(): boolean {
  try {
    return localStorage.getItem(LEGACY_ATTEMPTS_KEY) !== null
  } catch {
    return false
  }
}

export function deleteLegacyAttempts(): void {
  try {
    localStorage.removeItem(LEGACY_ATTEMPTS_KEY)
  } catch {
    /* nothing to delete */
  }
}
