import { Router, type Request } from 'express'
import { z } from 'zod'
import { authOf, requireAuth } from '../auth/context'
import { getOwnedAttemptWithScenario, recordEvent, recordLiveStarted } from '../attempts/service'
import { aiEnabled, env } from '../config/env'
import { ApiError } from '../http/errors'
import { assertSessionWithinLimit, onSessionStarted } from '../live/sessionGuard'
import { openaiClient } from '../openai/client'
import { PATIENT_PROMPT_VERSION, buildDelegateInstructions, buildPatientInstructions } from '../prompts/patient'
import { isToolName } from '../tools/contracts'
import { buildCaseTools } from '../tools/definitions'

const sessionBody = z.object({
  // An SDP offer is well over 100 bytes; the ceiling bounds abuse without
  // rejecting legitimate offers, which grow with codec and ICE candidate count.
  sdp: z.string().min(100).max(100_000),
  attemptId: z.string().uuid(),
})

const toolBody = z.object({
  attemptId: z.string().uuid(),
  callId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(100),
  arguments: z.string().max(10_000),
})

const hits = new Map<string, number[]>()

/** Each Live session is billed, so session creation is rate limited per client. */
function enforceRateLimit(req: Request): void {
  const key = req.ip ?? 'unknown'
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < env.LIVE_SESSION_RATE_WINDOW_MS)
  if (recent.length >= env.LIVE_SESSION_RATE_LIMIT) {
    throw new ApiError('Too many voice sessions started. Wait a moment.', 429, 'rate_limited')
  }
  recent.push(now)
  hits.set(key, recent)
}

/** Test seam. */
export function resetRateLimit(): void {
  hits.clear()
}

export const liveRouter: Router = Router()
liveRouter.use(requireAuth)

liveRouter.post('/session', async (req, res) => {
  if (!aiEnabled) {
    throw new ApiError(
      'Voice mode is not configured. Set OPENAI_API_KEY on the server, then restart it. Guided mode works without a key.',
      503,
      'missing_api_key',
    )
  }

  const parsed = sessionBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    throw new ApiError('Invalid voice session request', 400, 'invalid_body')
  }

  const auth = authOf(req)
  const { attempt, scenario } = await getOwnedAttemptWithScenario(auth, parsed.data.attemptId)
  if (attempt.status === 'submitted') {
    throw new ApiError('This attempt is already submitted.', 409, 'attempt_submitted')
  }
  enforceRateLimit(req)

  let result
  try {
    result = await openaiClient().live.create({
      session: {
        model: env.OPENAI_LIVE_MODEL,
        instructions: buildPatientInstructions(scenario),
        delegation: {
          type: 'responses',
          responses: {
            model: env.OPENAI_DELEGATE_MODEL,
            instructions: buildDelegateInstructions(scenario),
            tools: buildCaseTools(scenario),
            tool_choice: 'auto',
            parallel_tool_calls: false,
          },
        },
      },
      transport: { type: 'webrtc', sdp: parsed.data.sdp },
    })
  } catch (cause) {
    // Provider errors can carry request details and account context, so only a
    // coarse status is surfaced. The SDP and instructions are never logged.
    const status = typeof (cause as { status?: number })?.status === 'number'
      ? (cause as { status: number }).status
      : 0
    console.error('[live] session creation failed', {
      attemptId: attempt.id,
      status: status || 'unknown',
    })
    if (status === 401 || status === 403) {
      throw new ApiError(
        'The server rejected the OpenAI credentials. Check the API key and that the project has billing enabled.',
        502,
        'provider_auth_failed',
      )
    }
    if (status === 429) {
      throw new ApiError(
        'OpenAI rate limit or quota reached. Check the project usage limits.',
        502,
        'provider_rate_limited',
      )
    }
    throw new ApiError('Could not start the voice session.', 502, 'provider_unavailable')
  }

  await recordLiveStarted(auth, attempt.id, {
    sessionId: result.session.id,
    promptVersion: PATIENT_PROMPT_VERSION,
    liveModel: env.OPENAI_LIVE_MODEL,
    reasoningModel: env.OPENAI_DELEGATE_MODEL,
  })

  // The server owns the kill switch: close at the limit, and close this attempt's previous session.
  await onSessionStarted(attempt.id, result.session.id)

  // Only the SDP answer and session ID cross to the browser.
  res.json({ sessionId: result.session.id, sdp: result.transport.sdp })
})

/**
 * Browser relay for delegated tool calls. The browser forwards the call; the
 * hidden case state and all validation stay here. Keyed by call ID so a
 * retried relay never records twice.
 */
liveRouter.post('/tool', async (req, res) => {
  const parsed = toolBody.safeParse(req.body ?? {})
  if (!parsed.success) throw new ApiError('Invalid tool request', 400, 'invalid_body')
  if (!isToolName(parsed.data.name)) throw new ApiError('Unknown tool', 400, 'unknown_tool')

  let args: { actionIds?: unknown; confirmed?: unknown }
  try {
    args = JSON.parse(parsed.data.arguments || '{}')
  } catch {
    throw new ApiError('Tool arguments were not valid JSON', 400, 'invalid_tool_arguments')
  }

  // Validation-path backstop: past the limit, refuse the call and end the session server-side.
  // Ownership first, so another user's attempt ID reveals nothing.
  await getOwnedAttemptWithScenario(authOf(req), parsed.data.attemptId)
  if (!(await assertSessionWithinLimit(parsed.data.attemptId))) {
    throw new ApiError(`The voice session reached its ${env.MAX_LIVE_SESSION_MINUTES}-minute limit and was ended. Guided mode still works.`, 409, 'live_session_expired')
  }

  try {
    const { result } = await recordEvent(
      authOf(req),
      parsed.data.attemptId,
      `voice:${parsed.data.callId}`,
      {
        type: 'action',
        tool: parsed.data.name,
        actionIds: args.actionIds as string[],
        ...(typeof args.confirmed === 'boolean' ? { confirmed: args.confirmed } : {}),
      },
      'voice',
    )
    res.json({
      callId: parsed.data.callId,
      output: {
        ok: true,
        recorded: result.recorded,
        duplicates: result.duplicates,
        pendingConfirmation: result.pendingConfirmation,
        findings: result.reveals,
      },
    })
  } catch (cause) {
    // A rejected call is returned as a normal result so the conversation can
    // continue. Ownership failures still surface as HTTP errors.
    if (cause instanceof ApiError && cause.code !== 'attempt_not_found') {
      res.json({ callId: parsed.data.callId, output: { ok: false, reason: cause.message } })
      return
    }
    throw cause
  }
})
