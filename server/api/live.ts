import { Router, type Request } from 'express'
import { z } from 'zod'
import { aiEnabled, env } from '../config/env'
import { EncounterError, requireEncounter } from '../encounters/store'
import { openaiClient } from '../openai/client'
import { buildDelegateInstructions, buildPatientInstructions } from '../prompts/patient'
import { isToolName } from '../tools/contracts'
import { buildCaseTools } from '../tools/definitions'
import { executeTool } from '../tools/execute'

const sessionBody = z.object({
  // An SDP offer is well over 100 bytes; the ceiling bounds abuse without
  // rejecting legitimate offers, which grow with codec and ICE candidate count.
  sdp: z.string().min(100).max(100_000),
  encounterId: z.string().uuid(),
})

const toolBody = z.object({
  encounterId: z.string().uuid(),
  callId: z.string().min(1).max(200),
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
    throw new EncounterError('Too many voice sessions started. Wait a moment.', 429, 'rate_limited')
  }
  recent.push(now)
  hits.set(key, recent)
}

/** Test seam. */
export function resetRateLimit(): void {
  hits.clear()
}

export const liveRouter: Router = Router()

liveRouter.post('/session', async (req, res) => {
  if (!aiEnabled) {
    throw new EncounterError(
      'Voice mode is not configured. Set OPENAI_API_KEY on the server, then restart it. Guided mode works without a key.',
      503,
      'missing_api_key',
    )
  }
  enforceRateLimit(req)

  const parsed = sessionBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    throw new EncounterError('Invalid voice session request', 400, 'invalid_body')
  }

  const encounter = requireEncounter(parsed.data.encounterId)
  if (encounter.submitted) {
    throw new EncounterError('This encounter is already submitted', 409, 'encounter_submitted')
  }

  let result
  try {
    result = await openaiClient().live.create({
      session: {
        model: env.OPENAI_LIVE_MODEL,
        instructions: buildPatientInstructions(encounter.hidden),
        delegation: {
          type: 'responses',
          responses: {
            model: env.OPENAI_DELEGATE_MODEL,
            instructions: buildDelegateInstructions(encounter.hidden),
            tools: buildCaseTools(encounter.hidden),
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
      encounterId: encounter.id,
      status: status || 'unknown',
    })
    if (status === 401 || status === 403) {
      throw new EncounterError(
        'The server rejected the OpenAI credentials. Check the API key and that the project has billing enabled.',
        502,
        'provider_auth_failed',
      )
    }
    if (status === 429) {
      throw new EncounterError(
        'OpenAI rate limit or quota reached. Check the project usage limits.',
        502,
        'provider_rate_limited',
      )
    }
    throw new EncounterError('Could not start the voice session.', 502, 'provider_unavailable')
  }

  encounter.liveSessionId = result.session.id
  encounter.liveStartedAt = new Date().toISOString()

  // Only the SDP answer and session ID cross to the browser.
  res.json({ sessionId: result.session.id, sdp: result.transport.sdp })
})

/**
 * Browser relay for delegated tool calls. The browser forwards the call; the
 * hidden case state and all validation stay here. A server-side sideband can
 * later take ownership of this without the encounter components changing.
 */
liveRouter.post('/tool', (req, res) => {
  const parsed = toolBody.safeParse(req.body ?? {})
  if (!parsed.success) throw new EncounterError('Invalid tool request', 400, 'invalid_body')

  const encounter = requireEncounter(parsed.data.encounterId)
  if (!isToolName(parsed.data.name)) {
    throw new EncounterError('Unknown tool', 400, 'unknown_tool')
  }

  let args: unknown
  try {
    args = JSON.parse(parsed.data.arguments || '{}')
  } catch {
    throw new EncounterError('Tool arguments were not valid JSON', 400, 'invalid_tool_arguments')
  }

  try {
    const result = executeTool(encounter, parsed.data.name, args)
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
    // A rejected tool call is returned as a normal result so the conversation
    // can continue; the model is told it failed, not why in internal terms.
    if (cause instanceof EncounterError) {
      res.json({
        callId: parsed.data.callId,
        output: { ok: false, reason: cause.message },
      })
      return
    }
    throw cause
  }
})
