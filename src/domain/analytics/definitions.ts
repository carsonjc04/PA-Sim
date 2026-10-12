// The metric registry. Every value on the progress dashboard is computed by exactly one of these definitions.
// Changing what a definition computes (its formula or parameters) requires bumping its version; the
// metric-lock test enforces that against metric-lock.json. Run `npm run analytics:lock` after a bump.
import { CASE_TIERS, INTERVAL_LEVEL, REVIEW_TIERS } from './sufficiency'

export type MetricSource = 'attempts' | 'attempt_results' | 'attempt_events' | 'remediation_evidence' | 'remediation_derivations' | 'review_cards' | 'learning_events' | 'content_versions' | 'blueprint'

export interface MetricDefinition {
  id: string
  version: number
  label: string
  description: string
  sources: MetricSource[]
  /** What is computed, in plain words. Part of the locked fingerprint. */
  formula: string
  /** Parameters that change results. Part of the locked fingerprint. */
  params: Record<string, number | string | boolean>
}

const caseTiers = { ...CASE_TIERS, intervalLevel: INTERVAL_LEVEL }
const reviewTiers = { ...REVIEW_TIERS, intervalLevel: INTERVAL_LEVEL }

export const METRICS = {
  areaExposure: {
    id: 'area.exposure',
    version: 1,
    label: 'Exposure by area',
    description: 'How many submitted attempts, and how many distinct cases, touched each blueprint content and task category.',
    sources: ['attempts', 'content_versions', 'blueprint'],
    formula: 'For each blueprint category, count submitted attempts and the distinct cases among them. Content: the played content version matches the category crosswalk. Task: every attempt evidences the tasks its encounter phases map to; tasks no phase maps to have no exposure and are labelled as not measured by cases.',
    params: {},
  },
  areaProficiency: {
    id: 'area.proficiency',
    version: 1,
    label: 'Proficiency by area',
    description: 'Share of attempts in an area with no graded miss in an encounter phase that evidences the area. Hidden below the limited tier.',
    sources: ['attempts', 'remediation_evidence', 'content_versions', 'blueprint'],
    formula: 'Unit is an attempt. Content category: an attempt is clean when it has no miss of any kind. Task category: an attempt is clean when no miss falls in a phase mapped to the task (history/exam to history and physical; diagnostics to diagnostic studies; diagnosis to most likely diagnosis; treatment to clinical intervention and pharmaceutical therapeutics). Value = clean / attempts, with a Wilson interval, shown only at limited or adequate sufficiency.',
    params: { ...caseTiers, phaseTaskMap: 'recommend.PHASE_TASKS' },
  },
  objectiveEvidence: {
    id: 'objective.evidence',
    version: 1,
    label: 'Learning objective evidence',
    description: 'For each authored learning objective, the attempts that could show it and those with a miss mapped to it.',
    sources: ['remediation_evidence', 'remediation_derivations', 'content_versions'],
    formula: 'An attempt can show an objective when the remediation mapping it was derived with maps any rubric item to a knowledge component of that objective. A miss counts toward the objective when its stored knowledge components belong to it. Attempts derived under a mapping version that is no longer current keep their misses but are left out of the denominator.',
    params: caseTiers,
  },
  errorTypes: {
    id: 'error.frequency',
    version: 1,
    label: 'Error types',
    description: 'How often each error type was recorded, and in how many distinct attempts.',
    sources: ['remediation_evidence'],
    formula: 'Count remediation_evidence rows per error_type for submitted attempts, and the distinct attempts among them. An error type is recurring when it appears in at least the threshold of distinct attempts.',
    params: { recurringAttempts: 2 },
  },
  criticalSafety: {
    id: 'critical.safety',
    version: 1,
    label: 'Critical and unsafe actions',
    description: 'Each critical or unsafe rubric item the student triggered, and whether a later attempt of the same case avoided it.',
    sources: ['remediation_evidence', 'attempts'],
    formula: 'Group remediation_evidence rows of kind critical or unsafe by case and rubric item. Resolved when the most recent submitted attempt of that case does not contain the item and was submitted after the last time it was missed.',
    params: {},
  },
  decision: {
    id: 'decision.timing',
    version: 1,
    label: 'Time to decision and answer changes',
    description: 'Time from opening a case to proposing a diagnosis, and how often the primary diagnosis or its confidence changed.',
    sources: ['attempts', 'attempt_events'],
    formula: 'First = earliest confirmed diagnosis action row (retracted or not) minus attempt start. Final = the diagnosis row that was not retracted minus attempt start. Reported as median and quartiles over attempts. A change is each confirmed diagnosis row beyond the first; confidence changes are flips in the recorded confidence history.',
    params: caseTiers,
  },
  retention: {
    id: 'retrieval.retention',
    version: 1,
    label: 'Retrieval retention',
    description: 'Share of reviews of previously seen cards that were recalled, beside the scheduler’s expected recall.',
    sources: ['learning_events'],
    formula: 'Over learning_events of type retention: recalled / n, with a Wilson interval, shown at limited or adequate sufficiency. Expected recall is the mean stored FSRS retrievability over the same events.',
    params: reviewTiers,
  },
  workload: {
    id: 'retrieval.workload',
    version: 1,
    label: 'Due retrieval',
    description: 'Review cards due by the end of today’s study day, and how many were already due before it began.',
    sources: ['review_cards'],
    formula: 'The same queue the review page serves: cards due before the end of the local study day (04:00 cutoff). Overdue = due before the start of that day.',
    params: { dayCutoffHour: 4 },
  },
  coverage: {
    id: 'blueprint.coverage',
    version: 1,
    label: 'Blueprint coverage',
    description: 'For each blueprint content category: no case authored yet, authored but not attempted by you, or attempted.',
    sources: ['attempts', 'content_versions', 'blueprint'],
    formula: 'Authored = published cases whose current tags match the category crosswalk. Attempted = a submitted attempt whose played version matches it. Weight is the blueprint’s published percentage.',
    params: {},
  },
  trend: {
    id: 'trend.weekly',
    version: 1,
    label: 'Change over time',
    description: 'Per study week: attempts, distinct cases, clean task observations and recall, each with its own sample size.',
    sources: ['attempts', 'remediation_evidence', 'learning_events'],
    formula: 'Weeks start Monday 04:00 in the student’s zone. Attempts are placed by submitted_at and reviews by the event time, never by when the server received them. Each week reports clean task observations (attempt x evidenced task) over all observations and recall over retention events, each with sufficiency.',
    params: { ...caseTiers, ...reviewTiers, weekStart: 'monday', dayCutoffHour: 4 },
  },
  priorities: {
    id: 'recommendation.priorities',
    version: 1,
    label: 'Learning priorities',
    description: 'The top three things to work on, chosen by fixed rules from the metrics above.',
    sources: ['attempts', 'remediation_evidence', 'review_cards', 'learning_events', 'blueprint'],
    formula: 'Candidates in rank order: unresolved critical or unsafe action; due retrieval; weak area (limited+ sufficiency, score = miss rate x blueprint weight); recurring error type; authored but unattempted blueprint category (by weight); area with only insufficient evidence. Ties break by score, then weight, then id. At most two per kind; the first three are shown.',
    params: { maxShown: 3, maxPerKind: 2, recurringAttempts: 2, quickReviewSize: 5 },
  },
} as const satisfies Record<string, MetricDefinition>

export type MetricKey = keyof typeof METRICS

export const metricVersions = (): Record<string, number> => Object.fromEntries(Object.values(METRICS).map((m) => [m.id, m.version]))

/** One label for the whole set; bump with any metric version. The lock records which metric versions it covers. */
export const ANALYTICS_VERSION = 'analytics-2026-10-11.1'

/** The part of a definition that the version guards: what changes results. */
export const fingerprintInput = (m: MetricDefinition) => ({ id: m.id, sources: [...m.sources].sort(), formula: m.formula, params: m.params })
