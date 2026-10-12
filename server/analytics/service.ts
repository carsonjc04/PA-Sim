import type { AnalyticsDashboardQuery, PublicAnalyticsDashboard } from '../../src/api/contracts'
import { buildDashboard } from '../../src/domain/analytics/dashboard'
import { attemptFact } from '../../src/domain/analytics/facts'
import { isValidTimeZone } from '../../src/domain/review/day'
import type { Blueprint } from '../../src/domain/study/schema'
import { canonicalTags } from '../../src/domain/study/taxonomy'
import type { ScenarioDefinition } from '../../src/domain/types'
import * as attempts from '../attempts/repository'
import type { AuthContext } from '../auth/context'
import { contentPackage } from '../content/scenarios'
import { getPool } from '../db/pool'
import { ApiError } from '../http/errors'
import { now } from '../lib/clock'
import { dueKnowledge } from '../review/service'
import { assertNotRetired, blueprintById, studyItems } from '../study/service'
import * as repo from './repository'

export const DEFAULT_BLUEPRINT = 'nccpa-pance-2025'

function blueprintLabel(bp: Blueprint): string {
  if (bp.exam === 'pance') return 'PANCE'
  const rotation = contentPackage().taxonomy.eorRotations.find((r) => r.id === bp.rotation)
  return `${rotation?.label ?? bp.rotation ?? 'End of Rotation'} End of Rotation`
}

/**
 * The progress dashboard: computed on every request from the user's stored events, so it can never drift
 * from them. Reading due cards first runs the review backfill, which derives misses for any submitted attempt
 * still missing them; attempts that still have none are counted and left out rather than read as clean.
 */
export async function dashboard(auth: AuthContext, query: AnalyticsDashboardQuery): Promise<PublicAnalyticsDashboard> {
  if (!isValidTimeZone(query.timeZone)) throw new ApiError('Unknown time zone.', 400, 'invalid_query')
  const bp = blueprintById(query.blueprint ?? DEFAULT_BLUEPRINT)
  assertNotRetired(bp)
  const due = await dueKnowledge(auth, query.timeZone)

  const pool = getPool()
  const pkg = contentPackage()
  const [submitted, diagnosisEvents, evidence, retention] = await Promise.all([
    repo.listSubmittedAttempts(pool, auth.userId),
    repo.listDiagnosisEvents(pool, auth.userId),
    repo.listEvidence(pool, auth.userId),
    repo.listRetention(pool, auth.userId),
  ])
  const snapshots = new Map<string, ScenarioDefinition>()
  for (const id of new Set(submitted.map((a) => a.contentVersionId))) snapshots.set(id, await attempts.getContentDefinition(pool, id))

  const derived = submitted.filter((a) => a.derived)
  const facts = derived.map((attempt) => {
    const scenario = snapshots.get(attempt.contentVersionId)!
    return attemptFact({
      attempt,
      scenario,
      // Tags of the version played, resolved through the current vocabulary: a later re-tag never rewrites history.
      tags: canonicalTags(scenario.taxonomy, pkg.taxonomy),
      diagnosisEvents,
      evidence,
      remediation: pkg.remediation[attempt.scenarioId],
      library: pkg.knowledge,
    })
  })

  return buildDashboard({
    now: now(),
    timeZone: query.timeZone,
    blueprint: bp,
    blueprintLabel: blueprintLabel(bp),
    items: studyItems(),
    library: pkg.knowledge,
    attempts: facts,
    retention,
    due: due.map(({ cardId, label, due: at }) => ({ cardId, label, due: at })),
    notYetAnalyzed: submitted.length - derived.length,
  })
}
