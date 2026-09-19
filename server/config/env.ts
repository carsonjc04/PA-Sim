import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_LIVE_MODEL: z.string().default('gpt-live-1'),
  OPENAI_REASONING_MODEL: z.string().default('gpt-5.6-sol'),
  OPENAI_VOICE: z.string().optional(),
  OPENAI_DELEGATION_MODE: z.enum(['client', 'responses']).default('client'),
  ENABLE_AI_CASE_GENERATION: z.coerce.boolean().default(false),
  AI_CASE_MODE: z.enum(['bounded', 'handcrafted']).default('bounded'),
  MAX_LIVE_SESSION_MINUTES: z.coerce.number().int().positive().max(60).default(20),
  STORE_TRANSCRIPTS: z.coerce.boolean().default(false),
  LIVE_VOICE_RATE_PER_MINUTE_USD: z.coerce.number().nonnegative().default(0.05),
})

export type Env = z.infer<typeof schema>

function load(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid server environment: ${detail}`)
  }
  return parsed.data
}

export const env = load()

/** True when a key is present. The key itself never leaves this module. */
export const aiEnabled = Boolean(env.OPENAI_API_KEY)

/**
 * Sole accessor for the secret. Throws rather than returning undefined so a
 * missing key can never be silently interpolated into a request header.
 */
export function requireApiKey(): string {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured')
  return env.OPENAI_API_KEY
}

/** Capability payload for the browser. Contains no secret material. */
export function publicCapabilities() {
  return {
    aiEnabled,
    liveModel: env.OPENAI_LIVE_MODEL,
    reasoningModel: env.OPENAI_REASONING_MODEL,
    delegationMode: env.OPENAI_DELEGATION_MODE,
    caseGenerationEnabled: aiEnabled && env.ENABLE_AI_CASE_GENERATION,
    maxSessionMinutes: env.MAX_LIVE_SESSION_MINUTES,
    storeTranscripts: env.STORE_TRANSCRIPTS,
    estimatedVoiceRatePerMinuteUsd: env.LIVE_VOICE_RATE_PER_MINUTE_USD,
    setupHint: aiEnabled
      ? null
      : 'Set OPENAI_API_KEY on the server to enable AI voice mode. Guided mode works without it.',
  }
}

export { load as loadEnvFrom }
