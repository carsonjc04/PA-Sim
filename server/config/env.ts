import { z } from 'zod'
import { avatarCaseIds } from '../avatar/pilot'

const blankAsUnset = (value: unknown) => (value === '' ? undefined : value)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  /** Reverse-proxy hops in front of the server (1 on Render). Without it every client shares the proxy's address. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: z.preprocess(blankAsUnset, z.string().url().optional()),
  DATABASE_SSL: z.stringbool().default(false),

  /** `dev` trusts an X-Dev-User header and is impersonable; `none` refuses attempt endpoints. */
  AUTH_PROVIDER: z.enum(['none', 'dev']).default('none'),
  ALLOW_DEV_AUTH_IN_PRODUCTION: z.stringbool().default(false),

  OPENAI_API_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
  OPENAI_LIVE_MODEL: z.string().default('gpt-live-1'),
  OPENAI_DELEGATE_MODEL: z.string().default('gpt-5.6-terra'),
  OPENAI_VOICE: z.string().optional(),
  OPENAI_DELEGATION_MODE: z.enum(['client', 'responses']).default('responses'),

  /** Live sessions allowed per window, per client. Each one is billed. */
  LIVE_SESSION_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  LIVE_SESSION_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  ENABLE_AI_CASE_GENERATION: z.stringbool().default(false),
  AI_CASE_MODE: z.enum(['bounded', 'handcrafted']).default('bounded'),
  MAX_LIVE_SESSION_MINUTES: z.coerce.number().int().positive().max(60).default(20),
  /** No student activity for this long and the server ends the session (abandoned tabs). */
  LIVE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(120),
  /** Open voice sessions allowed across the whole server, and per client address. */
  LIVE_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(3),
  LIVE_MAX_SESSIONS_PER_CLIENT: z.coerce.number().int().positive().default(2),
  LIVE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  STORE_TRANSCRIPTS: z.stringbool().default(false),
  LIVE_VOICE_RATE_PER_MINUTE_USD: z.coerce.number().nonnegative().default(0.05),

  /** LiveAvatar (HeyGen) LITE: renders a face for the voice session's audio. Server-side only. */
  LIVEAVATAR_API_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
  /** Sandbox sessions are free but last about a minute and use LiveAvatar's one sandbox face. */
  LIVEAVATAR_SANDBOX: z.stringbool().default(false),
  /** The plan's per-session ceiling (the free plan allows 120 s). The avatar never outlives the voice deadline either. */
  LIVEAVATAR_MAX_SESSION_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  /** LITE uses 1 credit per minute, prorated; about $0.09–0.10 per credit on paid plans. */
  LIVEAVATAR_RATE_PER_MINUTE_USD: z.coerce.number().nonnegative().default(0.1),
})

export type Env = z.infer<typeof schema>

function load(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')

    throw new Error(`Invalid server environment: ${detail}`)
  }

  const data = parsed.data
  if (
    data.AUTH_PROVIDER === 'dev' &&
    data.NODE_ENV === 'production' &&
    !data.ALLOW_DEV_AUTH_IN_PRODUCTION
  ) {
    throw new Error(
      'Invalid server environment: AUTH_PROVIDER=dev is impersonable and is refused in production unless ALLOW_DEV_AUTH_IN_PRODUCTION=true',
    )
  }
  return data
}

export const env = load()

/** True when the impersonable dev provider is serving a production deployment. */
export const insecureAuth = env.AUTH_PROVIDER === 'dev' && env.NODE_ENV === 'production'

/** Indicates whether an API key was configured without exposing its value. */
export const aiEnabled = Boolean(env.OPENAI_API_KEY)

/** The avatar is a layer over voice, so it needs both keys. */
export const avatarEnabled = aiEnabled && Boolean(env.LIVEAVATAR_API_KEY)

/** Returns the API key or throws when it has not been configured. */
export function requireApiKey(): string {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured')
  }

  return env.OPENAI_API_KEY
}

/** Capability payload for the browser. Contains no secret material. */
export function publicCapabilities() {
  return {
    aiEnabled,
    liveModel: env.OPENAI_LIVE_MODEL,
    delegateModel: env.OPENAI_DELEGATE_MODEL,
    delegationMode: env.OPENAI_DELEGATION_MODE,
    caseGenerationEnabled: aiEnabled && env.ENABLE_AI_CASE_GENERATION,
    maxSessionMinutes: env.MAX_LIVE_SESSION_MINUTES,
    idleTimeoutSeconds: env.LIVE_IDLE_TIMEOUT_SECONDS,
    storeTranscripts: env.STORE_TRANSCRIPTS,
    estimatedVoiceRatePerMinuteUsd: env.LIVE_VOICE_RATE_PER_MINUTE_USD,
    avatarCaseIds: avatarEnabled ? avatarCaseIds() : [],
    estimatedAvatarRatePerMinuteUsd: env.LIVEAVATAR_RATE_PER_MINUTE_USD,
    avatarMaxSeconds: env.LIVEAVATAR_MAX_SESSION_SECONDS,
    setupHint: aiEnabled
      ? null
      : 'Set OPENAI_API_KEY on the server to enable AI voice mode. Guided mode works without it.',
  }
}

export { load as loadEnvFrom }