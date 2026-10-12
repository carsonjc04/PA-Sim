// Metric computations over normalized facts. Pure and clock-free: callers pass `now` and the zone.
// Every function sorts its input first, so the result never depends on the order rows arrive in;
// a late-arriving event lands where its own timestamp puts it.
import { errorTypes, type KnowledgeLibrary } from '../remediation/types'
import { dayStart, localDay } from '../review/day'
import { itemsInScope, matchesCrosswalk, type StudyItem } from '../study/coverage'
import { PHASE_TASKS } from '../study/recommend'
import type { Blueprint } from '../study/schema'
import { METRICS } from './definitions'
import { caseSufficiency, reviewSufficiency, showsValue, wilson } from './sufficiency'
import type {
  AreaResult,
  AttemptFact,
  CoverageResult,
  CriticalMissResult,
  DecisionResult,
  DueCardFact,
  DurationSummary,
  ErrorTypeResult,
  EvidenceRef,
  MissFact,
  ObjectiveResult,
  RateResult,
  Sufficiency,
  RetentionFact,
  RetentionResult,
  TrendBucket,
  TrendResult,
  WorkloadResult,
} from './types'

const byAttempt = (a: AttemptFact, b: AttemptFact) => a.submittedAt.localeCompare(b.submittedAt) || a.attemptId.localeCompare(b.attemptId)
export const sortAttempts = (facts: readonly AttemptFact[]) => [...facts].sort(byAttempt)
const sortRetention = (facts: readonly RetentionFact[]) => [...facts].sort((a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId))

export const attemptRef = (a: AttemptFact): EvidenceRef => ({ source: 'attempt', id: a.attemptId, at: a.submittedAt, attemptId: a.attemptId })
export const missRef = (m: MissFact): EvidenceRef => ({ source: 'remediation_evidence', id: m.evidenceId, at: m.at, attemptId: m.attemptId })
const retentionRef = (r: RetentionFact): EvidenceRef => ({ source: 'learning_event', id: r.eventId, at: r.at })

/** Tasks a miss in each phase counts against, and the tasks any encounter can show evidence for. */
const taskOfPhase = PHASE_TASKS
export const EVIDENCED_TASKS = [...new Set(Object.values(PHASE_TASKS).flat())]
const missesTask = (a: AttemptFact, task: string) => a.misses.filter((m) => taskOfPhase[m.phase].includes(task))

/**
 * A rate with its sample. Sufficiency is passed in because its unit (attempts and cases, or reviews and cards)
 * can differ from the rate's own trials; the value and interval are withheld below `limited`.
 */
export function rate(metric: { id: string; version: number }, successes: number, n: number, basis: { sufficiency: Sufficiency; distinctCases: number }, evidence: EvidenceRef[]): RateResult {
  const { sufficiency, distinctCases } = basis
  const shown = showsValue(sufficiency) && n > 0
  return {
    metricId: metric.id,
    version: metric.version,
    value: shown ? Math.round((successes / n) * 1000) / 1000 : null,
    successes,
    n,
    distinctCases,
    sufficiency,
    interval: shown ? wilson(successes, n) : null,
    evidence,
  }
}

// ---- Areas: exposure and proficiency, kept apart ----

function area(kind: AreaResult['kind'], id: string, label: string, weightPct: number, attempts: AttemptFact[], clean: (a: AttemptFact) => boolean, misses: (a: AttemptFact) => MissFact[], authoredCaseIds: string[]): AreaResult {
  const caseIds = [...new Set(attempts.map((a) => a.scenarioId))].sort()
  const evidence = [...attempts.map(attemptRef), ...attempts.flatMap((a) => misses(a).map(missRef))]
  const m = METRICS.areaProficiency
  return {
    kind,
    id,
    label,
    weightPct,
    exposure: { attempts: attempts.length, distinctCases: caseIds.length, caseIds },
    proficiency: rate(m, attempts.filter(clean).length, attempts.length, { sufficiency: caseSufficiency(attempts.length, caseIds.length), distinctCases: caseIds.length }, evidence),
    authoredCaseIds,
  }
}

export function areaResults(facts: readonly AttemptFact[], bp: Blueprint, items: readonly StudyItem[]): AreaResult[] {
  const sorted = sortAttempts(facts)
  const scoped = itemsInScope(bp, items)
  const content = bp.contentCategories.map((c) =>
    area(
      'content',
      c.id,
      c.label,
      c.weightPct,
      sorted.filter((a) => matchesCrosswalk(a.tags, c.crosswalk)),
      (a) => a.misses.length === 0,
      (a) => a.misses,
      scoped.filter((i) => matchesCrosswalk(i.tags, c.crosswalk)).map((i) => i.id).sort(),
    ),
  )
  const tasks = bp.taskCategories.map((t) => {
    const measured = EVIDENCED_TASKS.includes(t.canonicalTask)
    return area(
      'task',
      t.id,
      t.label,
      t.weightPct,
      measured ? sorted : [],
      (a) => missesTask(a, t.canonicalTask).length === 0,
      (a) => missesTask(a, t.canonicalTask),
      measured ? scoped.map((i) => i.id).sort() : [],
    )
  })
  return [...content, ...tasks]
}

// ---- Objectives ----

export function objectiveResults(facts: readonly AttemptFact[], library: KnowledgeLibrary | null): ObjectiveResult[] {
  if (!library) return []
  const sorted = sortAttempts(facts)
  const objectiveOfKc = new Map(library.components.map((c) => [c.id, c.objectiveIds]))
  const missObjectives = (m: MissFact) => new Set(m.kcIds.flatMap((kc) => objectiveOfKc.get(kc) ?? []))
  // Only objectives the student has played toward are listed, so an unplayed case's objectives never hint at it.
  return library.objectives.flatMap((o) => {
    const withMiss = sorted.filter((a) => a.misses.some((m) => missObjectives(m).has(o.id)))
    const counted = sorted.filter((a) => a.objectiveIds?.includes(o.id))
    const excluded = sorted.filter((a) => a.objectiveIds === null && a.misses.some((m) => missObjectives(m).has(o.id)))
    // Misses always count; an attempt under a superseded mapping joins the denominator only through a miss.
    const denominator = [...new Set([...counted, ...excluded])]
    const evidence = [...denominator.map(attemptRef), ...denominator.flatMap((a) => a.misses.filter((m) => missObjectives(m).has(o.id)).map(missRef))]
    if (!denominator.length) return []
    return [{
      objectiveId: o.id,
      statement: o.statement,
      attempts: denominator.length,
      attemptsWithMiss: withMiss.length,
      excludedForContentChange: sorted.filter((a) => a.objectiveIds === null).length - excluded.length,
      evidence,
      sufficiency: caseSufficiency(denominator.length, new Set(denominator.map((a) => a.scenarioId)).size),
    }]
  })
}

// ---- Error types ----

export function errorTypeResults(facts: readonly AttemptFact[]): ErrorTypeResult[] {
  const sorted = sortAttempts(facts)
  return errorTypes
    .map((errorType) => {
      const hits = sorted.flatMap((a) => a.misses.filter((m) => m.errorType === errorType).map((m) => ({ a, m })))
      return { errorType, occurrences: hits.length, attempts: new Set(hits.map((h) => h.a.attemptId)).size, evidence: hits.map((h) => missRef(h.m)) }
    })
    .filter((r) => r.occurrences > 0)
    .sort((a, b) => b.attempts - a.attempts || b.occurrences - a.occurrences || a.errorType.localeCompare(b.errorType))
}

// ---- Critical safety ----

export function criticalMisses(facts: readonly AttemptFact[]): CriticalMissResult[] {
  const sorted = sortAttempts(facts)
  const groups = new Map<string, { a: AttemptFact; m: MissFact }[]>()
  for (const a of sorted) {
    for (const m of a.misses) {
      if (m.kind !== 'critical' && m.kind !== 'unsafe') continue
      const key = `${a.scenarioId}\u0000${m.rubricItemId}`
      groups.set(key, [...(groups.get(key) ?? []), { a, m }])
    }
  }
  return [...groups.values()]
    .map((hits) => {
      const last = hits.at(-1)!
      const latestOfCase = sorted.filter((a) => a.scenarioId === last.a.scenarioId).at(-1)!
      const resolved = latestOfCase.attemptId !== last.a.attemptId && !latestOfCase.misses.some((m) => m.rubricItemId === last.m.rubricItemId)
      return {
        scenarioId: last.a.scenarioId,
        scenarioTitle: last.a.scenarioTitle,
        rubricItemId: last.m.rubricItemId,
        label: last.m.label,
        kind: last.m.kind as 'critical' | 'unsafe',
        lastMissedAt: last.a.submittedAt,
        resolved,
        evidence: [...hits.map((h) => missRef(h.m)), ...(resolved ? [attemptRef(latestOfCase)] : [])],
      }
    })
    .sort((a, b) => Number(a.resolved) - Number(b.resolved) || (a.kind === b.kind ? 0 : a.kind === 'critical' ? -1 : 1) || b.lastMissedAt.localeCompare(a.lastMissedAt) || a.rubricItemId.localeCompare(b.rubricItemId))
}

// ---- Time to decision and answer changes ----

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo))
}

function durations(samples: { ms: number; ref: EvidenceRef; scenarioId: string }[]): DurationSummary {
  const values = samples.map((s) => s.ms).sort((a, b) => a - b)
  const sufficiency = caseSufficiency(values.length, new Set(samples.map((s) => s.scenarioId)).size)
  const shown = showsValue(sufficiency)
  return {
    n: values.length,
    medianMs: shown ? quantile(values, 0.5) : null,
    q1Ms: shown ? quantile(values, 0.25) : null,
    q3Ms: shown ? quantile(values, 0.75) : null,
    sufficiency,
    evidence: samples.map((s) => s.ref),
  }
}

export function decisionResult(facts: readonly AttemptFact[]): DecisionResult {
  const sorted = sortAttempts(facts)
  const first: { ms: number; ref: EvidenceRef; scenarioId: string }[] = []
  const final: { ms: number; ref: EvidenceRef; scenarioId: string }[] = []
  let attemptsWithDiagnosisChange = 0
  let diagnosisChanges = 0
  let confidenceChanges = 0
  const evidence: EvidenceRef[] = []
  for (const a of sorted) {
    const rows = a.diagnosisEvents.filter((e) => e.confirmed).sort((x, y) => x.seq - y.seq)
    if (!rows.length) continue
    const start = Date.parse(a.startedAt)
    const ref = (e: (typeof rows)[number]): EvidenceRef => ({ source: 'attempt_event', id: e.eventId, at: e.at, attemptId: a.attemptId })
    first.push({ ms: Math.max(0, Date.parse(rows[0].at) - start), ref: ref(rows[0]), scenarioId: a.scenarioId })
    const kept = rows.filter((e) => !e.retracted).at(-1)
    if (kept) final.push({ ms: Math.max(0, Date.parse(kept.at) - start), ref: ref(kept), scenarioId: a.scenarioId })
    if (rows.length > 1) {
      attemptsWithDiagnosisChange += 1
      diagnosisChanges += rows.length - 1
    }
    for (const e of rows) {
      const flips = e.confidenceHistory.filter((h, i, all) => i > 0 && h.confidence !== all[i - 1].confidence).length
      confidenceChanges += flips
      if (rows.length > 1 || flips > 0) evidence.push(ref(e))
    }
  }
  const m = METRICS.decision
  return {
    metricId: m.id,
    version: m.version,
    firstDiagnosis: durations(first),
    finalDiagnosis: durations(final),
    attemptsWithDiagnosisChange,
    diagnosisChanges,
    confidenceChanges,
    attempts: first.length,
    sufficiency: caseSufficiency(first.length, new Set(first.map((f) => f.scenarioId)).size),
    evidence,
  }
}

// ---- Retrieval ----

export function retentionResult(facts: readonly RetentionFact[]): RetentionResult {
  const sorted = sortRetention(facts)
  const cards = new Set(sorted.map((r) => r.cardId)).size
  const m = METRICS.retention
  const scheduled = sorted.filter((r) => r.retrievability !== null)
  return {
    metricId: m.id,
    version: m.version,
    recall: rate(m, sorted.filter((r) => r.recalled).length, sorted.length, { sufficiency: reviewSufficiency(sorted.length, cards), distinctCases: cards }, sorted.map(retentionRef)),
    expectedRecall: scheduled.length && showsValue(reviewSufficiency(sorted.length, cards)) ? Math.round((scheduled.reduce((n, r) => n + (r.retrievability ?? 0), 0) / scheduled.length) * 1000) / 1000 : null,
    distinctCards: cards,
  }
}

export function workloadResult(due: readonly DueCardFact[], now: Date, timeZone: string): WorkloadResult {
  const day = localDay(now, timeZone)
  const startMs = dayStart(day, timeZone).getTime()
  const cards = [...due].sort((a, b) => a.due.localeCompare(b.due) || a.cardId.localeCompare(b.cardId))
  const m = METRICS.workload
  return { metricId: m.id, version: m.version, dueToday: cards.length, overdue: cards.filter((c) => Date.parse(c.due) < startMs).length, cards, localDay: day }
}

// ---- Coverage ----

export function coverageResult(facts: readonly AttemptFact[], bp: Blueprint, items: readonly StudyItem[]): CoverageResult {
  const scoped = itemsInScope(bp, items)
  const sorted = sortAttempts(facts)
  const categories = bp.contentCategories.map((c) => {
    const authoredCaseIds = scoped.filter((i) => matchesCrosswalk(i.tags, c.crosswalk)).map((i) => i.id).sort()
    const attemptedCaseIds = [...new Set(sorted.filter((a) => matchesCrosswalk(a.tags, c.crosswalk)).map((a) => a.scenarioId))].sort()
    const status: CoverageResult['categories'][number]['status'] = attemptedCaseIds.length ? 'attempted' : authoredCaseIds.length ? 'not-attempted' : 'not-authored'
    return { id: c.id, label: c.label, weightPct: c.weightPct, status, authoredCaseIds, attemptedCaseIds }
  })
  const weightByStatus = { 'not-authored': 0, 'not-attempted': 0, attempted: 0 }
  for (const c of categories) weightByStatus[c.status] += c.weightPct
  const m = METRICS.coverage
  return { metricId: m.id, version: m.version, blueprintId: bp.id, categories, weightByStatus }
}

// ---- Change over time ----

/** Monday of the study week an instant belongs to, in the student's zone with the 04:00 cutoff. */
export function weekOf(instant: string, timeZone: string): string {
  const [y, m, d] = localDay(new Date(instant), timeZone).split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}

export function trendResult(facts: readonly AttemptFact[], retention: readonly RetentionFact[], timeZone: string): TrendResult {
  const attempts = sortAttempts(facts)
  const reviews = sortRetention(retention)
  const weeks = [...new Set([...attempts.map((a) => weekOf(a.submittedAt, timeZone)), ...reviews.map((r) => weekOf(r.at, timeZone))])].sort()
  const m = METRICS.trend
  const buckets: TrendBucket[] = weeks.map((weekStart) => {
    const inWeek = attempts.filter((a) => weekOf(a.submittedAt, timeZone) === weekStart)
    const rev = reviews.filter((r) => weekOf(r.at, timeZone) === weekStart)
    const cases = new Set(inWeek.map((a) => a.scenarioId)).size
    const observations = inWeek.flatMap((a) => EVIDENCED_TASKS.map((task) => missesTask(a, task).length === 0))
    const cards = new Set(rev.map((r) => r.cardId)).size
    return {
      weekStart,
      attempts: inWeek.length,
      distinctCases: cases,
      // Sufficiency counts attempts and cases, not observations, so the five tasks of one attempt never
      // look like five independent pieces of evidence.
      taskClean: rate(m, observations.filter(Boolean).length, observations.length, { sufficiency: caseSufficiency(inWeek.length, cases), distinctCases: cases }, inWeek.map(attemptRef)),
      criticalMisses: inWeek.reduce((n, a) => n + a.misses.filter((x) => x.kind === 'critical' || x.kind === 'unsafe').length, 0),
      recall: rate(m, rev.filter((r) => r.recalled).length, rev.length, { sufficiency: reviewSufficiency(rev.length, cards), distinctCases: cards }, rev.map(retentionRef)),
    }
  })
  return { metricId: m.id, version: m.version, timeZone, buckets }
}
