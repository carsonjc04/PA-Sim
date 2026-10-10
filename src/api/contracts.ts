// Shared by the server (validation) and the browser (typing). Must never import scenario data or grading.
import { z } from 'zod'
import type { Category, PhaseId } from '../domain/types'

export const phaseIds = ['history', 'exam', 'diagnostics', 'diagnosis', 'treatment'] as const satisfies readonly PhaseId[]
export const phaseSchema = z.enum(phaseIds)

export const toolNames = [
  'record_history_topics',
  'request_physical_exam',
  'order_diagnostic_test',
  'record_communication_behavior',
  'propose_diagnosis',
  'propose_treatment_plan',
  'record_disposition',
  'record_follow_up',
] as const
export type ToolName = (typeof toolNames)[number]
export const toolNameSchema = z.enum(toolNames)

const stableId = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/)

export const startAttemptBody = z.object({ scenarioId: stableId }).strict()
export type StartAttemptBody = z.infer<typeof startAttemptBody>

export const attemptEventBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('action'),
      tool: toolNameSchema,
      actionIds: z.array(stableId).min(1).max(12),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('lock_phase'), phase: phaseSchema }).strict(),
  z.object({ type: z.literal('retract'), phase: phaseSchema, actionId: stableId }).strict(),
])
export type AttemptEventBody = z.infer<typeof attemptEventBody>

export const idempotencyKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9:_-]+$/)

export const historyQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(200).optional(),
    status: z.enum(['active', 'submitted']).optional(),
  })
  .strict()
export type HistoryQuery = z.infer<typeof historyQuery>

export const devUserSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,31}$/)

export type ApiErrorCode =
  | 'invalid_body'
  | 'invalid_query'
  | 'missing_idempotency_key'
  | 'idempotency_conflict'
  | 'auth_required'
  | 'auth_unavailable'
  | 'database_unavailable'
  | 'scenario_not_found' | 'scenario_retired'
  | 'attempt_not_found'
  | 'attempt_submitted'
  | 'unknown_tool'
  | 'unknown_action'
  | 'invalid_tool_arguments'
  | 'wrong_phase'
  | 'phase_locked'
  | 'event_not_found'
  | 'diagnosis_required'
  | 'ai_unavailable'
  | 'missing_api_key'
  | 'provider_auth_failed'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'not_found'
  | 'internal_error'

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; requestId?: string }
}

export interface PublicAction {
  id: string
  label: string
  paText: string
  kind?: string
}

export interface PublicScenario {
  id: string
  schemaVersion: string
  summary: {
    title: string
    complaint: string
    age: string
    pronouns: string
    difficulty: 'Foundational' | 'Intermediate' | 'Urgent'
    duration: string
    urgent: boolean
    setting: string
  }
  patient: { name: string; demographics: string; portrait: { src?: string; alt: string; fallback: string } }
  clinician: { src?: string; alt: string; fallback: string }
  opening: string
  initialInfo: string[]
  phases: { id: PhaseId; label: string; description: string; actions: PublicAction[] }[]
  diagnoses: { id: string; label: string }[]
  planOptions: { id: string; label: string; group: string }[]
  /** Coarse label only: reviewer, dates, notes and lifecycle status are maintainer data. */
  reviewStatus: 'requires-clinician-review' | 'clinician-reviewed'
  clinicalReferences: { title: string; organization: string; url: string; publishedOrUpdated?: string }[]
}

export interface PublicEvent {
  seq: number
  phase: PhaseId
  actionId: string
  kind: string
  confirmed: boolean
  revealed: string | null
  source: 'guided' | 'voice'
  at: string
}

/** Released only after submission, and only from the stored result. */
export interface PublicDebrief {
  gradingVersionId: string
  contentVersionId: string
  gradedAt: string
  categoryScores: Record<Category, number>
  rawScore: number
  finalScore: number
  passed: boolean
  criticalSafetyError: boolean
  criticalMessages: string[]
  strengths: string[]
  missed: string[]
  unnecessary: string[]
  unsafe: string[]
  correctDiagnosisLabel: string
  diagnosisReasoning: string
  idealPlan: string[]
}

export interface PublicAttempt {
  id: string
  scenarioId: string
  contentVersionId: string
  status: 'active' | 'submitted'
  currentPhase: PhaseId
  lockedPhases: PhaseId[]
  scenario: PublicScenario
  events: PublicEvent[]
  createdAt: string
  submittedAt: string | null
  debrief: PublicDebrief | null
}

export interface StartAttemptResponse {
  attempt: PublicAttempt
  resumed: boolean
}

export interface EventResult {
  recorded: string[]
  duplicates: string[]
  pendingConfirmation: string[]
  reveals: { id: string; text: string }[]
}

export interface EventResponse {
  result: EventResult
  attempt: PublicAttempt
}

export interface AttemptSummary {
  id: string
  scenarioId: string
  scenarioTitle: string
  status: 'active' | 'submitted'
  createdAt: string
  submittedAt: string | null
  finalScore: number | null
  passed: boolean | null
}

export interface HistoryPage {
  items: AttemptSummary[]
  nextCursor: string | null
}

export interface AuthStatus {
  provider: 'dev' | 'none'
  available: boolean
  /** True when the impersonable dev provider serves a production deployment. */
  insecure: boolean
  user: { displayName: string } | null
}
