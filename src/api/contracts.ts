// Shared by the server (validation) and the browser (typing). Must never import scenario data or grading.
import { z } from 'zod'
import type { ErrorType, MissKind, PromptType } from '../domain/remediation/types'
import type { AlignmentClaim, BlueprintCoverage, FullExamGate } from '../domain/study/coverage'
import type { PairPlan } from '../domain/study/recommend'
import type { BlueprintLifecycle } from '../domain/study/blueprints'
import type { Category, PhaseId, Suitability } from '../domain/types'

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
      /** Optional, primary diagnosis only: how sure the student is, captured before the outcome is known. */
      confidence: z.enum(['sure', 'unsure']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('lock_phase'), phase: phaseSchema }).strict(),
  z.object({ type: z.literal('retract'), phase: phaseSchema, actionId: stableId }).strict(),
]).refine((b) => b.type !== 'action' || b.confidence === undefined || b.tool === 'propose_diagnosis', {
  message: 'confidence is only recorded with propose_diagnosis',
  path: ['confidence'],
})
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
  | 'attempt_not_submitted'
  | 'invalid_time_zone'
  | 'review_card_not_found'
  | 'review_session_not_found'
  | 'blueprint_not_found'
  | 'blueprint_retired'
  | 'sprint_not_found'
  | 'sprint_locked'
  | 'notes_conflict'
  | 'annotation_target_not_found'
  | 'review_out_of_order'

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
  /**
   * Canonical study tags (deprecated IDs resolved) used for filtering. Organ system and task only; the diagnosis,
   * rubric and topic-level tags stay server-side.
   */
  tags: { organSystems: string[]; panceTasks: string[]; eorRotations: string[]; suitability: Suitability }
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

// ---- Remediation and Today's Review ----

/** IANA zone name from the browser. Validity is checked on the server with Intl. */
export const timeZoneSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/)
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

export const reviewModes = ['all', 'micro'] as const
export type ReviewMode = (typeof reviewModes)[number]
/** Size of the "Quick 5" micro-session. */
export const MICRO_SESSION_SIZE = 5

export const startReviewSessionBody = z.object({ mode: z.enum(reviewModes), timeZone: timeZoneSchema, restart: z.boolean().optional() }).strict()
export type StartReviewSessionBody = z.infer<typeof startReviewSessionBody>
export const timeZoneQuery = z.object({ timeZone: timeZoneSchema }).strict()

export const submitReviewBody = z
  .object({
    sessionId: uuidSchema,
    promptId: stableId,
    /** 1 Missed it · 2 Hard · 3 Got it · 4 Easy */
    rating: z.number().int().min(1).max(4),
    /** Milliseconds from the prompt being shown to the answer being revealed. */
    latencyMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
  })
  .strict()
export type SubmitReviewBody = z.infer<typeof submitReviewBody>

export const reviewEventBody = z
  .object({ type: z.enum(['shown', 'answered']), cardId: uuidSchema, latencyMs: z.number().int().min(0).max(3_600_000).optional() })
  .strict()
export type ReviewEventBody = z.infer<typeof reviewEventBody>

export interface PublicReviewItem {
  cardId: string
  status: 'done' | 'current' | 'upcoming'
  knowledgeLabel: string
  prompt: { id: string; type: PromptType; front: string; choices?: string[] }
  answer: string
  explanation: string
  /** Why this item is due. Deterministic: derived from the stored due reason. */
  reason: { code: 'new-miss' | 'new-evidence' | 'scheduled'; text: string }
  /** The graded miss this card came from, for the jump back to the debrief. */
  source: { attemptId: string; scenarioTitle: string; rubricItemId: string; label: string } | null
}

export interface PublicReviewSession {
  id: string
  localDay: string
  mode: ReviewMode
  position: number
  total: number
  done: boolean
  /** True while any shown content is unreviewed draft content. */
  draftContent: boolean
  items: PublicReviewItem[]
}

export interface ReviewSessionResponse {
  session: PublicReviewSession | null
  resumed: boolean
  dueToday: number
}

export interface SubmitReviewResponse {
  cardId: string
  rating: number
  nextDue: string
  nextDueInDays: number
  session: { id: string; position: number; total: number; done: boolean }
}

export interface ReviewSummary {
  localDay: string
  dueToday: number
  totalCards: number
}

export interface PublicRemediationItem {
  rubricItemId: string
  label: string
  kind: MissKind
  errorType: ErrorType
  status: 'linked' | 'unmapped'
  cards: { cardId: string; knowledgeLabel: string; due: string; dueToday: boolean }[]
}

export interface AttemptRemediation {
  attemptId: string
  /** False when review content has not been authored for this case yet. */
  authored: boolean
  draftContent: boolean
  items: PublicRemediationItem[]
}

// ---- Study modes ----

export interface PublicTerm { id: string; label: string }

/** Active vocabulary for filters. Deprecated IDs are never offered. */
export interface PublicTaxonomy {
  organSystems: PublicTerm[]
  panceTasks: PublicTerm[]
  eorRotations: PublicTerm[]
}

export interface PublicBlueprintSummary {
  id: string
  issuer: 'NCCPA' | 'PAEA'
  exam: 'pance' | 'eor'
  rotation: string | null
  title: string
  versionLabel: string
  /** Derived from the recorded dates on the server's current day. */
  lifecycle: BlueprintLifecycle
  effectiveFrom: string | null
  effectiveUntil: string | null
  dateNotes: string
  source: { documentUrl: string; landingPage: string; retrievedAt: string; sha256: string; retrievedVia: string | null; retrievalNote: string | null }
  /** False until a second person re-checks every transcribed number against the source. */
  transcriptionVerified: boolean
  examItems: number | null
  notes: string[]
}

export interface PublicSecondaryTarget {
  id: string
  label: string
  partition: boolean
  values: { id: string; label: string; minPct: number; maxPct: number; itemIds: string[] }[]
}

export interface PublicCoverage {
  blueprint: PublicBlueprintSummary
  coverage: BlueprintCoverage
  secondaryTargets: PublicSecondaryTarget[]
  /** Items referenced by id in the coverage. Titles only. */
  items: { id: string; title: string }[]
  fullExam: FullExamGate
  alignment: AlignmentClaim
}

export const studyModes = ['rotation', 'pance', 'mixed'] as const
export type StudyMode = (typeof studyModes)[number]
export const studyPlanQuery = z
  .object({ mode: z.enum(studyModes), blueprint: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(120), timeZone: timeZoneSchema })
  .strict()

export interface PublicStudyPlan {
  blueprintId: string
  mode: StudyMode
  /** Interleaved, highest weakness x weight first. */
  pairs: PairPlan[]
  basis: {
    submittedAttempts: number
    /** Plain-language description of the ranking, shown to the learner. */
    method: string
  }
  dueRemediation: { cardId: string; label: string; due: string }[]
}

export interface PublicSprint {
  id: string
  sourceScenarioId: string
  sourceTitle: string
  /** Sprints reveal their source case's diagnosis, so they open only after that case is submitted. */
  locked: boolean
  draft: boolean
  stem: string | null
  findings: { label: string; text: string }[]
  options: { id: string; label: string }[]
  tags: { organSystems: string[]; panceTasks: string[]; eorRotations: string[] }
}

export const sprintAnswerBody = z.object({ optionId: z.string().min(1).max(120) }).strict()
export type SprintAnswerBody = z.infer<typeof sprintAnswerBody>

export interface SprintAnswerResult {
  correct: boolean
  chosen: { id: string; label: string }
  answer: { id: string; label: string }
  /** The source case's authored reasoning for each option, where it exists. */
  reasoning: { id: string; label: string; text: string | null }[]
}

// ---- Learner notes and annotations (owner-only; never part of attempt payloads) ----

export const NOTES_MAX_LENGTH = 4000
export const annotationMarks = ['ruled_out', 'key', 'revisit'] as const
export type AnnotationMark = (typeof annotationMarks)[number]
export const annotationTargetKinds = ['action', 'diagnosis', 'plan'] as const
export type AnnotationTargetKind = (typeof annotationTargetKinds)[number]

export interface PublicNotes {
  body: string
  /** 0 when nothing has been saved yet. Send it back with the next save. */
  version: number
  updatedAt: string | null
}

export const saveNotesBody = z
  .object({ body: z.string().max(NOTES_MAX_LENGTH), version: z.number().int().min(0) })
  .strict()
export type SaveNotesBody = z.infer<typeof saveNotesBody>

/** 409 notes_conflict carries the saved copy so the learner can choose. */
export interface NotesConflictBody {
  error: { code: 'notes_conflict'; message: string; requestId?: string }
  current: PublicNotes
}

export interface PublicAnnotation {
  targetKind: AnnotationTargetKind
  targetId: string
  marks: AnnotationMark[]
}

export const setAnnotationBody = z
  .object({
    targetKind: z.enum(annotationTargetKinds),
    targetId: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(120),
    marks: z.array(z.enum(annotationMarks)).max(3),
  })
  .strict()
export type SetAnnotationBody = z.infer<typeof setAnnotationBody>

// ---- Voice capability (GET /api/ai/status) ----

export interface AiStatus {
  aiEnabled: boolean
  setupHint: string | null
  /** Advertised session cap. The client ends the session at this point. */
  maxSessionMinutes: number
  /** Estimate shown to learners in plain language; not a bill. */
  estimatedVoiceRatePerMinuteUsd: number
  storeTranscripts: boolean
}
