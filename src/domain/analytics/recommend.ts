// The top learning priorities, chosen by fixed rules (recommendation.priorities in definitions.ts).
// Deterministic: the same metrics always give the same priorities in the same order. The "why" text is
// built only from metric values, so every sentence can be traced to the evidence it carries.
import { errorTypeLabels } from '../remediation/labels'
import { METRICS } from './definitions'
import { showsValue } from './sufficiency'
import type { AreaResult, AttemptFact, CoverageResult, CriticalMissResult, ErrorTypeResult, Priority, PriorityKind, WorkloadResult } from './types'
import { attemptRef, missRef, sortAttempts } from './metrics'

export const KIND_ORDER: PriorityKind[] = ['critical-safety', 'due-retrieval', 'weak-area', 'recurring-error', 'coverage-gap', 'thin-evidence']

export interface PriorityInputs {
  attempts: readonly AttemptFact[]
  areas: readonly AreaResult[]
  critical: readonly CriticalMissResult[]
  errorTypes: readonly ErrorTypeResult[]
  workload: WorkloadResult
  coverage: CoverageResult
  /** Titles of published cases, by id. */
  caseTitles: Readonly<Record<string, string>>
  blueprintLabel: string
}

interface Candidate extends Priority {
  score: number
  weightPct: number
  id: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const pct = (x: number) => `${Math.round(x * 100)}%`
const caseHref = (id: string) => `/encounter/${encodeURIComponent(id)}`

/** Prefers a case never played, then the one played longest ago; ties by id. */
function pickCase(caseIds: readonly string[], attempts: readonly AttemptFact[]): string | null {
  if (!caseIds.length) return null
  const last = new Map<string, string>()
  for (const a of sortAttempts(attempts)) last.set(a.scenarioId, a.submittedAt)
  return [...caseIds].sort((a, b) => (last.get(a) ?? '').localeCompare(last.get(b) ?? '') || a.localeCompare(b))[0]
}

function candidates(input: PriorityInputs): Candidate[] {
  const m = METRICS.priorities
  const out: Candidate[] = []
  const title = (id: string) => input.caseTitles[id] ?? id

  for (const c of input.critical.filter((x) => !x.resolved)) {
    out.push({
      kind: 'critical-safety',
      id: `${c.scenarioId}/${c.rubricItemId}`,
      score: Date.parse(c.lastMissedAt),
      weightPct: 0,
      title: `Revisit a safety issue in ${title(c.scenarioId)}`,
      why: `Your last attempt of ${title(c.scenarioId)} included ${c.kind === 'critical' ? 'a critical safety error' : 'an unsafe choice'}: "${c.label}". No later attempt of this case has avoided it yet.`,
      nextAction: { label: `Retry ${title(c.scenarioId)}`, href: caseHref(c.scenarioId) },
      basis: { n: c.evidence.length, unit: 'attempts', sufficiency: 'insufficient' },
      metricIds: [METRICS.criticalSafety.id, m.id],
      evidence: c.evidence,
    })
  }

  const w = input.workload
  if (w.dueToday > 0) {
    out.push({
      kind: 'due-retrieval',
      id: 'due',
      score: w.dueToday,
      weightPct: 0,
      title: `Review ${plural(w.dueToday, 'due card')}`,
      why: `${plural(w.dueToday, 'review card is', 'review cards are')} due today${w.overdue ? `, ${w.overdue} of them from before today` : ''}. Each one comes from a miss in one of your debriefs.`,
      nextAction: { label: w.dueToday > m.params.quickReviewSize ? `Start a quick ${m.params.quickReviewSize}` : 'Start review', href: '/review' },
      basis: { n: w.dueToday, unit: 'cards', sufficiency: null },
      metricIds: [METRICS.workload.id, m.id],
      evidence: [],
    })
  }

  for (const a of input.areas) {
    const p = a.proficiency
    if (!showsValue(p.sufficiency) || p.value === null || p.value >= 1) continue
    const missRate = 1 - p.value
    const pick = pickCase(a.authoredCaseIds, input.attempts)
    if (!pick) continue
    const missed = p.n - p.successes
    out.push({
      kind: 'weak-area',
      id: `${a.kind}/${a.id}`,
      score: missRate * a.weightPct,
      weightPct: a.weightPct,
      title: `Strengthen ${a.label}`,
      why: `${missed} of your ${plural(p.n, 'attempt')} across ${plural(p.distinctCases, 'case')} had a miss in ${a.label} (${pct(missRate)}; ${p.sufficiency} evidence). It is ${a.weightPct}% of the ${input.blueprintLabel} blueprint.`,
      nextAction: { label: `Practice ${title(pick)}`, href: caseHref(pick) },
      basis: { n: p.n, unit: 'attempts', sufficiency: p.sufficiency },
      metricIds: [METRICS.areaProficiency.id, m.id],
      evidence: p.evidence,
    })
  }

  for (const e of input.errorTypes.filter((x) => x.attempts >= m.params.recurringAttempts)) {
    const latest = sortAttempts(input.attempts)
      .filter((a) => a.misses.some((x) => x.errorType === e.errorType))
      .at(-1)!
    const miss = latest.misses.find((x) => x.errorType === e.errorType)!
    out.push({
      kind: 'recurring-error',
      id: e.errorType,
      score: e.attempts,
      weightPct: 0,
      title: `Work on a repeated pattern: ${errorTypeLabels[e.errorType]}`,
      why: `"${errorTypeLabels[e.errorType]}" was recorded ${plural(e.occurrences, 'time')} across ${plural(e.attempts, 'different attempt')}. The most recent was "${miss.label}" in ${latest.scenarioTitle}.`,
      nextAction: { label: 'Reread that debrief', href: `/results/${encodeURIComponent(latest.attemptId)}#miss-${encodeURIComponent(miss.rubricItemId)}` },
      basis: { n: e.attempts, unit: 'attempts', sufficiency: 'insufficient' },
      metricIds: [METRICS.errorTypes.id, m.id],
      evidence: [...e.evidence, attemptRef(latest), missRef(miss)].filter((r, i, all) => all.findIndex((x) => x.source === r.source && x.id === r.id) === i),
    })
  }

  for (const c of input.coverage.categories.filter((x) => x.status === 'not-attempted')) {
    const pick = pickCase(c.authoredCaseIds, input.attempts)!
    out.push({
      kind: 'coverage-gap',
      id: c.id,
      score: c.weightPct,
      weightPct: c.weightPct,
      title: `Start on ${c.label}`,
      why: `${c.label} is ${c.weightPct}% of the ${input.blueprintLabel} blueprint. ${plural(c.authoredCaseIds.length, 'published case covers', 'published cases cover')} it and you have not attempted one yet.`,
      nextAction: { label: `Practice ${title(pick)}`, href: caseHref(pick) },
      basis: { n: 0, unit: 'attempts', sufficiency: 'none' },
      metricIds: [METRICS.coverage.id, m.id],
      evidence: [],
    })
  }

  for (const a of input.areas.filter((x) => x.kind === 'content' && x.proficiency.sufficiency === 'insufficient')) {
    const pick = pickCase(a.authoredCaseIds, input.attempts)
    if (!pick) continue
    out.push({
      kind: 'thin-evidence',
      id: a.id,
      score: a.weightPct,
      weightPct: a.weightPct,
      title: `Get a reliable read on ${a.label}`,
      why: `You have ${plural(a.exposure.attempts, 'attempt')} across ${plural(a.exposure.distinctCases, 'case')} in ${a.label}. That is not enough to tell a strength or weakness from chance.`,
      nextAction: { label: `Practice ${title(pick)}`, href: caseHref(pick) },
      basis: { n: a.exposure.attempts, unit: 'attempts', sufficiency: 'insufficient' },
      metricIds: [METRICS.areaExposure.id, m.id],
      evidence: a.proficiency.evidence.filter((r) => r.source === 'attempt'),
    })
  }
  return out
}

export function priorities(input: PriorityInputs): Priority[] {
  const m = METRICS.priorities
  const ranked = candidates(input).sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.score - a.score || b.weightPct - a.weightPct || a.id.localeCompare(b.id),
  )
  const perKind = new Map<PriorityKind, number>()
  const out: Priority[] = []
  for (const c of ranked) {
    if (out.length >= m.params.maxShown) break
    const used = perKind.get(c.kind) ?? 0
    if (used >= m.params.maxPerKind) continue
    perKind.set(c.kind, used + 1)
    const { score: _score, weightPct: _weight, id: _id, ...priority } = c
    out.push(priority)
  }
  return out
}
