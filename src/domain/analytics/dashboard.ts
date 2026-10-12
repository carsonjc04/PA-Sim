// Assembles the progress dashboard from facts. Pure and deterministic given its inputs.
import type { KnowledgeLibrary } from '../remediation/types'
import type { StudyItem } from '../study/coverage'
import type { Blueprint } from '../study/schema'
import { ANALYTICS_VERSION, metricVersions } from './definitions'
import { areaResults, coverageResult, criticalMisses, decisionResult, errorTypeResults, objectiveResults, retentionResult, trendResult, workloadResult } from './metrics'
import { READINESS } from './readiness'
import { priorities } from './recommend'
import type {
  AreaResult,
  AttemptFact,
  CoverageResult,
  CriticalMissResult,
  DecisionResult,
  DueCardFact,
  ErrorTypeResult,
  ObjectiveResult,
  Priority,
  Readiness,
  RetentionFact,
  RetentionResult,
  TrendResult,
  WorkloadResult,
} from './types'

export interface AnalyticsDashboard {
  analyticsVersion: string
  metricVersions: Record<string, number>
  generatedAt: string
  timeZone: string
  blueprint: { id: string; label: string }
  /** Submitted attempts behind every metric; `notYetAnalyzed` ones have no derived misses yet and are left out. */
  totals: { analyzedAttempts: number; distinctCases: number; notYetAnalyzed: number }
  priorities: Priority[]
  dueRetrieval: WorkloadResult
  coverage: CoverageResult
  areas: AreaResult[]
  objectives: ObjectiveResult[]
  errorTypes: ErrorTypeResult[]
  criticalSafety: CriticalMissResult[]
  decision: DecisionResult
  retention: RetentionResult
  trend: TrendResult
  readiness: Readiness
}

export interface DashboardInputs {
  now: Date
  timeZone: string
  blueprint: Blueprint
  /** Short label used in sentences, e.g. "PANCE". */
  blueprintLabel: string
  items: readonly StudyItem[]
  library: KnowledgeLibrary | null
  attempts: readonly AttemptFact[]
  retention: readonly RetentionFact[]
  due: readonly DueCardFact[]
  notYetAnalyzed: number
}

export function buildDashboard(input: DashboardInputs): AnalyticsDashboard {
  const areas = areaResults(input.attempts, input.blueprint, input.items)
  const coverage = coverageResult(input.attempts, input.blueprint, input.items)
  const critical = criticalMisses(input.attempts)
  const errors = errorTypeResults(input.attempts)
  const dueRetrieval = workloadResult(input.due, input.now, input.timeZone)
  return {
    analyticsVersion: ANALYTICS_VERSION,
    metricVersions: metricVersions(),
    generatedAt: input.now.toISOString(),
    timeZone: input.timeZone,
    blueprint: { id: input.blueprint.id, label: input.blueprintLabel },
    totals: { analyzedAttempts: input.attempts.length, distinctCases: new Set(input.attempts.map((a) => a.scenarioId)).size, notYetAnalyzed: input.notYetAnalyzed },
    priorities: priorities({
      attempts: input.attempts,
      areas,
      critical,
      errorTypes: errors,
      workload: dueRetrieval,
      coverage,
      caseTitles: Object.fromEntries(input.items.map((i) => [i.id, i.title])),
      blueprintLabel: input.blueprintLabel,
    }),
    dueRetrieval,
    coverage,
    areas,
    objectives: objectiveResults(input.attempts, input.library),
    errorTypes: errors,
    criticalSafety: critical,
    decision: decisionResult(input.attempts),
    retention: retentionResult(input.retention),
    trend: trendResult(input.attempts, input.retention, input.timeZone),
    readiness: READINESS,
  }
}
