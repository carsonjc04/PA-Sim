// Learning analytics domain: normalized facts read from stored events, and the metrics derived from them.
// Pure types. Every number shown to a student is one of these results, and every result names its evidence.
import type { ErrorType, MissKind } from '../remediation/types'
import type { PhaseId } from '../types'
import type { ItemTags } from '../study/taxonomy'

/** A pointer to the stored row a statement is based on. `id` is that row's primary key. */
export interface EvidenceRef {
  source: 'attempt' | 'attempt_event' | 'remediation_evidence' | 'learning_event'
  id: string
  at: string
  /** The attempt the row belongs to, so the UI can link to its debrief. Absent for review events. */
  attemptId?: string
}

/** How much evidence a value rests on. Below `limited` a rate is not shown. */
export type Sufficiency = 'none' | 'insufficient' | 'limited' | 'adequate'

/** One graded miss as stored in remediation_evidence. */
export interface MissFact {
  evidenceId: string
  attemptId: string
  rubricItemId: string
  kind: MissKind
  errorType: ErrorType
  phase: PhaseId
  label: string
  kcIds: string[]
  at: string
}

/** One diagnosis action row, retracted or not. Retracted rows are how a changed answer is recorded. */
export interface DiagnosisEventFact {
  eventId: string
  seq: number
  actionId: string
  confirmed: boolean
  retracted: boolean
  at: string
  /** Confidence changes recorded on this row, oldest first. */
  confidenceHistory: { confidence: 'sure' | 'unsure'; at: string }[]
}

/** One submitted attempt, normalized from attempts, attempt_results, attempt_events and remediation_evidence. */
export interface AttemptFact {
  attemptId: string
  scenarioId: string
  scenarioTitle: string
  contentVersionId: string
  startedAt: string
  submittedAt: string
  /** Tags of the content version that was played, resolved through the current vocabulary. */
  tags: ItemTags
  criticalSafetyError: boolean
  misses: MissFact[]
  diagnosisEvents: DiagnosisEventFact[]
  /**
   * Objectives this attempt could show evidence for, from the remediation mapping the attempt was derived with.
   * Null when that mapping version is no longer the current one, so the denominator is unknown.
   */
  objectiveIds: string[] | null
}

/** One `retention` learning event: a card reviewed at least once before. */
export interface RetentionFact {
  eventId: string
  cardId: string
  recalled: boolean
  retrievability: number | null
  at: string
}

export interface DueCardFact {
  cardId: string
  label: string
  due: string
}

export interface Interval {
  low: number
  high: number
  /** Coverage of the interval, e.g. 0.8. */
  level: number
}

/** A rate with its sample. `value` is null whenever sufficiency is below `limited`. */
export interface RateResult {
  metricId: string
  version: number
  /** Successes over trials, 0–1. */
  value: number | null
  successes: number
  n: number
  distinctCases: number
  sufficiency: Sufficiency
  interval: Interval | null
  evidence: EvidenceRef[]
}

/** Exposure and proficiency for one blueprint category, kept apart. */
export interface AreaResult {
  kind: 'content' | 'task'
  id: string
  label: string
  weightPct: number
  /** Exposure: attempts and distinct cases that touched this area. */
  exposure: { attempts: number; distinctCases: number; caseIds: string[] }
  /** Proficiency: share of those attempts with no miss evidencing this area. */
  proficiency: RateResult
  /** Published cases in scope for this area, whether or not attempted. */
  authoredCaseIds: string[]
}

export interface ObjectiveResult {
  objectiveId: string
  statement: string
  /** Attempts whose mapping could show this objective; null denominator attempts are excluded. */
  attempts: number
  /** Attempts with at least one miss mapped to this objective. */
  attemptsWithMiss: number
  /** Attempts where the mapping changed since derivation; their misses still count, their clean passes do not. */
  excludedForContentChange: number
  evidence: EvidenceRef[]
  sufficiency: Sufficiency
}

export interface ErrorTypeResult {
  errorType: ErrorType
  occurrences: number
  attempts: number
  evidence: EvidenceRef[]
}

export interface CriticalMissResult {
  scenarioId: string
  scenarioTitle: string
  rubricItemId: string
  label: string
  kind: 'critical' | 'unsafe'
  lastMissedAt: string
  /** True when a later attempt of the same case did not repeat this miss. */
  resolved: boolean
  evidence: EvidenceRef[]
}

export interface DurationSummary {
  n: number
  medianMs: number | null
  q1Ms: number | null
  q3Ms: number | null
  sufficiency: Sufficiency
  evidence: EvidenceRef[]
}

export interface DecisionResult {
  metricId: string
  version: number
  /** From opening the case to the first diagnosis the student proposed. */
  firstDiagnosis: DurationSummary
  /** From opening the case to the diagnosis that was kept. */
  finalDiagnosis: DurationSummary
  /** Attempts in which the primary diagnosis was replaced at least once. */
  attemptsWithDiagnosisChange: number
  diagnosisChanges: number
  /** Changes of recorded confidence on the same diagnosis. */
  confidenceChanges: number
  attempts: number
  sufficiency: Sufficiency
  evidence: EvidenceRef[]
}

export interface RetentionResult {
  metricId: string
  version: number
  recall: RateResult
  /** Mean FSRS retrievability (the scheduler’s expected recall) over the same events; compare with recall.value. */
  expectedRecall: number | null
  distinctCards: number
}

export interface WorkloadResult {
  metricId: string
  version: number
  dueToday: number
  /** Of those, due before today's study day began. */
  overdue: number
  cards: DueCardFact[]
  localDay: string
}

export interface CoverageCategory {
  id: string
  label: string
  weightPct: number
  status: 'not-authored' | 'not-attempted' | 'attempted'
  authoredCaseIds: string[]
  attemptedCaseIds: string[]
}

export interface CoverageResult {
  metricId: string
  version: number
  blueprintId: string
  categories: CoverageCategory[]
  /** Blueprint weight (percentage points) per status, so "how much is untouched" is honest about authoring. */
  weightByStatus: Record<CoverageCategory['status'], number>
}

export interface TrendBucket {
  /** Monday of the study week (YYYY-MM-DD), in the student's zone with the 04:00 cutoff. */
  weekStart: string
  attempts: number
  distinctCases: number
  /** Area observations (attempt x task) without a miss, over all observations that week. */
  taskClean: RateResult
  criticalMisses: number
  recall: RateResult
}

export interface TrendResult {
  metricId: string
  version: number
  timeZone: string
  buckets: TrendBucket[]
}

export type PriorityKind = 'critical-safety' | 'due-retrieval' | 'weak-area' | 'recurring-error' | 'coverage-gap' | 'thin-evidence'

export interface Priority {
  kind: PriorityKind
  title: string
  why: string
  nextAction: { label: string; href: string }
  /** How much evidence the selection rests on. Sufficiency is null for a plain count (cards due), which is not an estimate. */
  basis: { n: number; unit: 'attempts' | 'cards'; sufficiency: Sufficiency | null }
  metricIds: string[]
  evidence: EvidenceRef[]
}

export interface Readiness {
  available: false
  reason: string
  protocol: string
}
