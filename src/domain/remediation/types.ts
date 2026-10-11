// Remediation domain: knowledge components, graded misses and spaced-review state.
// Pure types. Content (prompts, answers) is loaded on the server only and never bundled.
import type { PhaseId } from '../types'

export const errorTypes = [
  'knowledge-gap',
  'data-gathering-omission',
  'interpretation-error',
  'premature-closure',
  'unsafe-action',
  'communication-lapse',
  'guessed-correct',
] as const
export type ErrorType = (typeof errorTypes)[number]

export const promptTypes = ['recall', 'discrimination', 'next-best-step', 'differential'] as const
export type PromptType = (typeof promptTypes)[number]

/** Confidence recorded at primary-diagnosis confirmation. Absent means the student skipped it. */
export type Confidence = 'sure' | 'unsure'

/** Synthetic rubric item id for "correct primary diagnosis, but recorded as unsure". */
export const GUESSED_CORRECT_ITEM = 'guessed-correct'

export interface LearningObjective { id: string; statement: string; panceTasks: string[] }
export interface KnowledgeComponent { id: string; label: string; objectiveIds: string[]; panceTasks: string[]; organSystems: string[] }
export interface KnowledgeLibrary { libraryVersion: string; provenance: 'author-proposed-unreviewed' | 'reviewed'; objectives: LearningObjective[]; components: KnowledgeComponent[] }

/** How one rubric item maps to knowledge. `errorType` overrides the default classification rule. */
export interface RubricMapping { kcIds: string[]; errorType?: ErrorType }

export interface ReviewPrompt {
  id: string
  kcId: string
  type: PromptType
  front: string
  /** Options for discrimination/differential prompts. The answer is revealed, never typed. */
  choices?: string[]
  answer: string
  explanation: string
}

/** Sidecar remediation content for one scenario (content/remediation/<scenarioId>.json). */
export interface ScenarioRemediation {
  scenarioId: string
  remediationVersion: string
  provenance: 'author-proposed-unreviewed' | 'reviewed'
  mappings: Record<string, RubricMapping>
  prompts: ReviewPrompt[]
}

export type MissKind = 'omission' | 'unnecessary' | 'unsafe' | 'critical' | 'wrong-diagnosis' | 'guessed-correct'

/** One graded miss, traceable to a rubric item in the pinned case definition. */
export interface Miss { rubricItemId: string; kind: MissKind; phase: PhaseId; label: string }

/** The reason a card is due. Stored with the card and rendered by a pure function, so it is deterministic. */
export type DueReasonCode = 'new-miss' | 'new-evidence' | 'scheduled'
export interface DueReason { code: DueReasonCode; at: string; attemptId?: string; rubricItemId?: string; evidenceId?: string; lastReviewedAt?: string }

/** Ratings shown as plain words. 1–4 match FSRS Again/Hard/Good/Easy. */
export type ReviewRating = 1 | 2 | 3 | 4

/** FSRS memory state plus scheduling metadata, as persisted per card. */
export interface ReviewState {
  state: 0 | 1 | 2 | 3
  due: string
  stability: number
  difficulty: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  lastReview: string | null
}

/** A remediation item: one card per user per knowledge component, with its evidence. */
export interface RemediationItem { id: string; kcId: string; review: ReviewState; dueReason: DueReason; algorithmVersion: string; paramsId: string; evidenceIds: string[] }

/** One answered review, append-only. Enough to replay the card under a newer algorithm. */
export interface ReviewEvent { id: string; cardId: string; promptId: string; promptType: PromptType; rating: ReviewRating; reviewedAt: string; latencyMs: number | null; algorithmVersion: string; paramsId: string }
