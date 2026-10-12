import { describe, expect, it } from 'vitest'
import pance from '../../../content/blueprints/nccpa-pance-2025.json'
import type { KnowledgeLibrary, ScenarioRemediation } from '../remediation/types'
import type { StudyItem } from '../study/coverage'
import type { Blueprint } from '../study/schema'
import type { ItemTags } from '../study/taxonomy'
import type { PhaseId, ScenarioDefinition } from '../types'
import { buildDashboard, type DashboardInputs } from './dashboard'
import { attemptFact, objectiveIdsFor } from './facts'
import { areaResults, coverageResult, criticalMisses, decisionResult, EVIDENCED_TASKS, objectiveResults, retentionResult, trendResult, weekOf, workloadResult } from './metrics'
import { READINESS } from './readiness'
import { priorities } from './recommend'
import { caseSufficiency, reviewSufficiency, wilson } from './sufficiency'
import type { AttemptFact, DiagnosisEventFact, MissFact, RetentionFact } from './types'

const bp = pance as unknown as Blueprint
const TZ = 'America/Denver'

const tags = (organSystems: string[]): ItemTags => ({ organSystems, panceTasks: [...EVIDENCED_TASKS], topicTags: [], careSettings: [], ageGroups: [], eorRotations: [] })
const item = (id: string, title: string, systems: string[]): StudyItem => ({ id, title, kind: 'case', tags: tags(systems), status: 'draft', blueprintReviews: [] })
const items: StudyItem[] = [
  item('asthma', 'Wheezing and shortness of breath', ['pulmonary-system']),
  item('respiratory', 'Cough and sore throat', ['pulmonary-system', 'eyes-ears-nose-throat', 'infectious-diseases']),
  item('chest-pressure', 'Chest pressure with sweating', ['cardiovascular-system']),
  item('metabolic', 'Fatigue, thirst, and frequent urination', ['endocrine-system']),
]
const systemsOf = Object.fromEntries(items.map((i) => [i.id, i.tags.organSystems]))

let n = 0
const id = (prefix: string) => `${prefix}-${String((n += 1)).padStart(4, '0')}`

function miss(o: Partial<MissFact> & { phase: PhaseId }): MissFact {
  return { evidenceId: id('ev'), attemptId: 'unset', rubricItemId: id('item'), kind: 'omission', errorType: 'data-gathering-omission', label: 'Skipped a screen', kcIds: [], at: '2026-10-05T18:00:00.000Z', ...o }
}

function attempt(o: { scenarioId: string; submittedAt: string; startedAt?: string; misses?: MissFact[]; dx?: DiagnosisEventFact[]; systems?: string[]; objectiveIds?: string[] | null }): AttemptFact {
  const startedAt = o.startedAt ?? new Date(Date.parse(o.submittedAt) - 600_000).toISOString()
  const attemptId = id('attempt')
  for (const m of o.misses ?? []) m.attemptId = attemptId
  return {
    attemptId,
    scenarioId: o.scenarioId,
    scenarioTitle: items.find((i) => i.id === o.scenarioId)?.title ?? o.scenarioId,
    contentVersionId: `${o.scenarioId}@aaaaaaaaaaaa`,
    startedAt,
    submittedAt: o.submittedAt,
    tags: tags(o.systems ?? systemsOf[o.scenarioId]),
    criticalSafetyError: (o.misses ?? []).some((m) => m.kind === 'critical'),
    misses: o.misses ?? [],
    diagnosisEvents: o.dx ?? [],
    objectiveIds: o.objectiveIds === undefined ? [] : o.objectiveIds,
  }
}

const dx = (o: Partial<DiagnosisEventFact> & { at: string }): DiagnosisEventFact => ({ eventId: id('event'), seq: 1, actionId: 'viral-uri', confirmed: true, retracted: false, confidenceHistory: [], ...o })
const retention = (at: string, recalled: boolean, cardId = 'card-1'): RetentionFact => ({ eventId: id('le'), cardId, recalled, retrievability: 0.9, at })

const NOW = new Date('2026-10-11T21:00:00Z') // 15:00 MDT, Sunday
const inputs = (o: Partial<DashboardInputs> = {}): DashboardInputs => ({ now: NOW, timeZone: TZ, blueprint: bp, blueprintLabel: 'PANCE', items, library: null, attempts: [], retention: [], due: [], notYetAnalyzed: 0, ...o })

/** Deterministic shuffle (reverse, then rotate) so order-independence is tested without randomness. */
const shuffle = <T,>(xs: readonly T[]) => {
  const r = [...xs].reverse()
  return [...r.slice(1), ...r.slice(0, 1)]
}

const area = (results: ReturnType<typeof areaResults>, areaId: string) => results.find((a) => a.id === areaId)!

describe('sufficiency', () => {
  it('never treats replays of one case as more than insufficient', () => {
    expect(caseSufficiency(0, 0)).toBe('none')
    expect(caseSufficiency(1, 1)).toBe('insufficient')
    expect(caseSufficiency(9, 1)).toBe('insufficient')
    expect(caseSufficiency(3, 2)).toBe('limited')
    expect(caseSufficiency(6, 2)).toBe('limited')
    expect(caseSufficiency(6, 3)).toBe('adequate')
  })
  it('uses reviews and distinct cards for retrieval', () => {
    expect(reviewSufficiency(0, 0)).toBe('none')
    expect(reviewSufficiency(4, 4)).toBe('insufficient')
    expect(reviewSufficiency(5, 1)).toBe('insufficient')
    expect(reviewSufficiency(5, 2)).toBe('limited')
    expect(reviewSufficiency(20, 5)).toBe('adequate')
  })
  it('gives a Wilson interval inside [0, 1] that narrows with n', () => {
    expect(wilson(0, 0)).toBeNull()
    const small = wilson(2, 3)!
    const large = wilson(20, 30)!
    expect(small.low).toBeGreaterThanOrEqual(0)
    expect(small.high).toBeLessThanOrEqual(1)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
    expect(wilson(3, 3)!.high).toBe(1)
    expect(wilson(0, 3)!.low).toBe(0)
  })
})

describe('small samples', () => {
  it('reports one perfect case as exposure only: no proficiency value, labelled insufficient', () => {
    const a = attempt({ scenarioId: 'asthma', submittedAt: '2026-10-05T18:00:00.000Z' })
    const pulm = area(areaResults([a], bp, items), 'pulmonary-system')
    expect(pulm.exposure).toEqual({ attempts: 1, distinctCases: 1, caseIds: ['asthma'] })
    expect(pulm.proficiency).toMatchObject({ value: null, interval: null, successes: 1, n: 1, sufficiency: 'insufficient' })
    const dash = buildDashboard(inputs({ attempts: [a] }))
    expect(dash.priorities.some((p) => p.kind === 'weak-area')).toBe(false)
    expect(dash.priorities.find((p) => p.kind === 'thin-evidence' && p.title.includes('Pulmonary'))?.basis).toEqual({ n: 1, unit: 'attempts', sufficiency: 'insufficient' })
  })

  it('shows a rate with its interval once the limited tier is reached, separately from exposure', () => {
    const attempts = [
      attempt({ scenarioId: 'asthma', submittedAt: '2026-10-05T18:00:00.000Z', misses: [miss({ phase: 'history' })] }),
      attempt({ scenarioId: 'respiratory', submittedAt: '2026-10-06T18:00:00.000Z' }),
      attempt({ scenarioId: 'asthma', submittedAt: '2026-10-07T18:00:00.000Z', misses: [miss({ phase: 'diagnostics' })] }),
    ]
    const pulm = area(areaResults(attempts, bp, items), 'pulmonary-system')
    expect(pulm.exposure.attempts).toBe(3)
    expect(pulm.proficiency).toMatchObject({ value: 0.333, successes: 1, n: 3, distinctCases: 2, sufficiency: 'limited' })
    expect(pulm.proficiency.interval).toEqual(wilson(1, 3))
    // Every attempt and every miss behind the number is cited.
    expect(pulm.proficiency.evidence.filter((e) => e.source === 'attempt')).toHaveLength(3)
    expect(pulm.proficiency.evidence.filter((e) => e.source === 'remediation_evidence')).toHaveLength(2)
  })

  it('counts a miss only against the tasks its phase evidences, and leaves unmeasured tasks empty', () => {
    const attempts = ['asthma', 'respiratory', 'chest-pressure'].map((s, i) =>
      attempt({ scenarioId: s, submittedAt: `2026-10-0${5 + i}T18:00:00.000Z`, misses: i === 0 ? [miss({ phase: 'diagnostics' })] : [] }),
    )
    const results = areaResults(attempts, bp, items)
    expect(area(results, 'using-diagnostic-laboratory-studies').proficiency).toMatchObject({ successes: 2, n: 3 })
    expect(area(results, 'formulating-the-most-likely-diagnosis').proficiency).toMatchObject({ successes: 3, n: 3 })
    expect(area(results, 'health-maintenance-education-prevention')).toMatchObject({ exposure: { attempts: 0 }, proficiency: { sufficiency: 'none', value: null }, authoredCaseIds: [] })
  })
})

describe('late events and order independence', () => {
  const attempts = [
    attempt({ scenarioId: 'asthma', submittedAt: '2026-09-29T18:00:00.000Z', misses: [miss({ phase: 'history', kind: 'critical', errorType: 'unsafe-action', rubricItemId: 'crit-1' })] }),
    attempt({ scenarioId: 'respiratory', submittedAt: '2026-10-06T18:00:00.000Z', misses: [miss({ phase: 'treatment', errorType: 'knowledge-gap' })] }),
    attempt({ scenarioId: 'asthma', submittedAt: '2026-10-07T18:00:00.000Z' }),
    attempt({ scenarioId: 'chest-pressure', submittedAt: '2026-10-08T18:00:00.000Z', misses: [miss({ phase: 'treatment', errorType: 'knowledge-gap' })] }),
  ]
  const reviews = [retention('2026-10-06T19:00:00.000Z', true), retention('2026-10-07T19:00:00.000Z', false, 'card-2')]

  it('gives identical results whatever order the rows arrive in', () => {
    const a = buildDashboard(inputs({ attempts, retention: reviews }))
    const b = buildDashboard(inputs({ attempts: shuffle(attempts), retention: shuffle(reviews) }))
    expect(b).toEqual(a)
  })

  it('places an event that arrives last by its own timestamp, in the week it happened', () => {
    const late = retention('2026-09-30T19:00:00.000Z', true, 'card-3')
    const trend = trendResult(attempts, [...reviews, late], TZ)
    expect(trend.buckets.map((b) => b.weekStart)).toEqual(['2026-09-28', '2026-10-05'])
    expect(trend.buckets[0]).toMatchObject({ attempts: 1, recall: { n: 1, successes: 1 }, criticalMisses: 1 })
    expect(trend.buckets[1]).toMatchObject({ attempts: 3, distinctCases: 3, recall: { n: 2, successes: 1 } })
  })

  it('reports each week with its own sample size and withholds rates for thin weeks', () => {
    const trend = trendResult(attempts, reviews, TZ)
    expect(trend.buckets[0].taskClean).toMatchObject({ n: EVIDENCED_TASKS.length, sufficiency: 'insufficient', value: null })
    // Three attempts across three cases: the task-clean rate is shown, but sufficiency counts attempts, not observations.
    expect(trend.buckets[1].taskClean).toMatchObject({ n: 3 * EVIDENCED_TASKS.length, sufficiency: 'limited' })
    expect(trend.buckets[1].taskClean.value).toBeCloseTo((3 * EVIDENCED_TASKS.length - 4) / (3 * EVIDENCED_TASKS.length), 3)
  })
})

describe('time zone boundaries', () => {
  it('uses the 04:00 local cutoff for the Monday week start', () => {
    expect(weekOf('2026-10-12T09:59:00.000Z', 'America/Denver')).toBe('2026-10-05') // Mon 03:59 MDT is still Sunday's study day
    expect(weekOf('2026-10-12T10:00:00.000Z', 'America/Denver')).toBe('2026-10-12') // Mon 04:00 MDT
  })
  it('puts the same instant in different weeks for different zones', () => {
    const instant = '2026-10-11T20:00:00.000Z' // Sun 13:00 in Los Angeles, Mon 05:00 in Tokyo
    expect(weekOf(instant, 'America/Los_Angeles')).toBe('2026-10-05')
    expect(weekOf(instant, 'Asia/Tokyo')).toBe('2026-10-12')
    const a = [attempt({ scenarioId: 'asthma', submittedAt: instant })]
    expect(trendResult(a, [], 'America/Los_Angeles').buckets[0].weekStart).toBe('2026-10-05')
    expect(trendResult(a, [], 'Asia/Tokyo').buckets[0].weekStart).toBe('2026-10-12')
  })
  it('handles the week after a DST change (America/Denver falls back 2026-11-01)', () => {
    expect(weekOf('2026-11-02T10:59:00.000Z', 'America/Denver')).toBe('2026-10-26') // Mon 03:59 MST
    expect(weekOf('2026-11-02T11:00:00.000Z', 'America/Denver')).toBe('2026-11-02') // Mon 04:00 MST
  })
  it('counts overdue cards against the start of the local study day', () => {
    const due = [
      { cardId: 'a', label: 'A', due: '2026-10-11T09:59:00.000Z' }, // before 04:00 MDT today
      { cardId: 'b', label: 'B', due: '2026-10-11T10:00:00.000Z' },
    ]
    expect(workloadResult(due, NOW, 'America/Denver')).toMatchObject({ dueToday: 2, overdue: 1, localDay: '2026-10-11' })
  })
})

describe('content version changes', () => {
  const library: KnowledgeLibrary = {
    libraryVersion: '0.1.0',
    provenance: 'author-proposed-unreviewed',
    objectives: [
      { id: 'obj-a', statement: 'Objective A', panceTasks: [] },
      { id: 'obj-b', statement: 'Objective B', panceTasks: [] },
    ],
    components: [
      { id: 'kc-a', label: 'A', objectiveIds: ['obj-a'], panceTasks: [], organSystems: [] },
      { id: 'kc-b', label: 'B', objectiveIds: ['obj-b'], panceTasks: [], organSystems: [] },
    ],
  }
  const remediation = { scenarioId: 'respiratory', remediationVersion: '0.2.0', provenance: 'author-proposed-unreviewed', mappings: { x: { kcIds: ['kc-a'] }, y: { kcIds: ['kc-b'] } }, prompts: [] } as ScenarioRemediation

  it('knows an attempt’s objectives only under the mapping version it was derived with', () => {
    expect(objectiveIdsFor('0.2.0', remediation, library)).toEqual(['obj-a', 'obj-b'])
    expect(objectiveIdsFor('0.1.0', remediation, library)).toBeNull()
    expect(objectiveIdsFor(null, undefined, library)).toEqual([])
    expect(objectiveIdsFor('0.1.0', undefined, library)).toBeNull()
  })

  it('keeps misses from a superseded mapping but leaves its clean attempts out of the denominator', () => {
    const current = attempt({ scenarioId: 'respiratory', submittedAt: '2026-10-06T18:00:00.000Z', objectiveIds: ['obj-a', 'obj-b'] })
    const oldClean = attempt({ scenarioId: 'respiratory', submittedAt: '2026-10-01T18:00:00.000Z', objectiveIds: null })
    const oldMiss = attempt({ scenarioId: 'respiratory', submittedAt: '2026-10-02T18:00:00.000Z', objectiveIds: null, misses: [miss({ phase: 'history', kcIds: ['kc-a'] })] })
    const results = objectiveResults([current, oldClean, oldMiss], library)
    expect(results.find((r) => r.objectiveId === 'obj-a')).toMatchObject({ attempts: 2, attemptsWithMiss: 1, excludedForContentChange: 1 })
    expect(results.find((r) => r.objectiveId === 'obj-b')).toMatchObject({ attempts: 1, attemptsWithMiss: 0, excludedForContentChange: 2 })
  })

  it('does not list objectives the student has not played toward', () => {
    expect(objectiveResults([attempt({ scenarioId: 'asthma', submittedAt: '2026-10-06T18:00:00.000Z' })], library)).toEqual([])
  })

  it('reads tags and misses from the version that was played, not the current one', () => {
    const scenario = { summary: { title: 'Cough and sore throat' } } as ScenarioDefinition
    const stored = { id: 'att-1', scenarioId: 'respiratory', contentVersionId: 'respiratory@old', createdAt: '2026-10-01T17:00:00.000Z', submittedAt: '2026-10-01T18:00:00.000Z', criticalSafetyError: false, derivationVersion: '0.1.0' }
    const evidence = [{ id: 'ev-1', attemptId: 'att-1', rubricItemId: 'removed-later', kind: 'omission' as const, errorType: 'knowledge-gap' as const, phase: 'history' as const, label: 'Old item', kcIds: [], createdAt: '2026-10-01T18:00:00.000Z' }]
    const fact = attemptFact({ attempt: stored, scenario, tags: tags(['cardiovascular-system']), diagnosisEvents: [], evidence, remediation, library })
    // The old version was tagged cardiovascular; the rubric item it missed no longer exists but still counts.
    expect(area(areaResults([fact], bp, items), 'cardiovascular-system').exposure.attempts).toBe(1)
    expect(area(areaResults([fact], bp, items), 'pulmonary-system').exposure.attempts).toBe(0)
    expect(fact.misses.map((m) => m.rubricItemId)).toEqual(['removed-later'])
    expect(fact.objectiveIds).toBeNull()
  })
})

describe('time to decision and answer changes', () => {
  it('measures first and kept diagnosis from the attempt start, and counts changes of mind', () => {
    const start = '2026-10-06T18:00:00.000Z'
    const at = (min: number) => new Date(Date.parse(start) + min * 60_000).toISOString()
    const attempts = [
      attempt({ scenarioId: 'asthma', startedAt: start, submittedAt: at(20), dx: [dx({ seq: 4, at: at(5), retracted: true, actionId: 'pneumonia' }), dx({ seq: 7, at: at(8) })] }),
      attempt({ scenarioId: 'respiratory', startedAt: start, submittedAt: at(20), dx: [dx({ seq: 3, at: at(6), confidenceHistory: [{ confidence: 'unsure', at: at(6) }, { confidence: 'sure', at: at(7) }] })] }),
      attempt({ scenarioId: 'chest-pressure', startedAt: start, submittedAt: at(20), dx: [dx({ seq: 2, at: at(10) })] }),
    ]
    const d = decisionResult(attempts)
    expect(d).toMatchObject({ attempts: 3, attemptsWithDiagnosisChange: 1, diagnosisChanges: 1, confidenceChanges: 1, sufficiency: 'limited' })
    expect(d.firstDiagnosis).toMatchObject({ n: 3, medianMs: 6 * 60_000, q1Ms: 5.5 * 60_000, q3Ms: 8 * 60_000 })
    expect(d.finalDiagnosis).toMatchObject({ n: 3, medianMs: 8 * 60_000 })
    expect(d.evidence.map((e) => e.source)).toEqual(['attempt_event', 'attempt_event', 'attempt_event'])
  })

  it('withholds timing for a single attempt', () => {
    const d = decisionResult([attempt({ scenarioId: 'asthma', submittedAt: '2026-10-06T18:20:00.000Z', dx: [dx({ at: '2026-10-06T18:15:00.000Z' })] })])
    expect(d.firstDiagnosis).toMatchObject({ n: 1, medianMs: null, sufficiency: 'insufficient' })
  })

  it('reads confidence written before history was kept as a single entry', () => {
    const fact = attemptFact({
      attempt: { id: 'a1', scenarioId: 'asthma', contentVersionId: 'asthma@x', createdAt: '2026-10-01T17:00:00.000Z', submittedAt: '2026-10-01T18:00:00.000Z', criticalSafetyError: false, derivationVersion: null },
      scenario: { summary: { title: 'Wheezing' } } as ScenarioDefinition,
      tags: tags(['pulmonary-system']),
      diagnosisEvents: [{ id: '9', attemptId: 'a1', seq: 3, actionId: 'asthma', confirmed: true, retractedAt: null, detail: { confidence: 'sure' }, createdAt: '2026-10-01T17:30:00.000Z' }],
      evidence: [],
      remediation: undefined,
      library: null,
    })
    expect(fact.diagnosisEvents[0].confidenceHistory).toEqual([{ confidence: 'sure', at: '2026-10-01T17:30:00.000Z' }])
  })
})

describe('critical safety', () => {
  const crit = () => miss({ phase: 'treatment', kind: 'critical', errorType: 'unsafe-action', rubricItemId: 'crit-discharge', label: 'Discharged home' })
  it('is unresolved until a later attempt of the same case avoids it', () => {
    const first = attempt({ scenarioId: 'chest-pressure', submittedAt: '2026-10-01T18:00:00.000Z', misses: [crit()] })
    expect(criticalMisses([first])[0]).toMatchObject({ resolved: false, kind: 'critical', rubricItemId: 'crit-discharge' })
    const repeat = attempt({ scenarioId: 'chest-pressure', submittedAt: '2026-10-02T18:00:00.000Z', misses: [crit()] })
    expect(criticalMisses([first, repeat])[0]).toMatchObject({ resolved: false })
    const clean = attempt({ scenarioId: 'chest-pressure', submittedAt: '2026-10-03T18:00:00.000Z' })
    const resolved = criticalMisses([first, repeat, clean])[0]
    expect(resolved).toMatchObject({ resolved: true })
    expect(resolved.evidence.map((e) => e.source)).toEqual(['remediation_evidence', 'remediation_evidence', 'attempt'])
  })
  it('is not resolved by a different case', () => {
    const first = attempt({ scenarioId: 'chest-pressure', submittedAt: '2026-10-01T18:00:00.000Z', misses: [crit()] })
    const other = attempt({ scenarioId: 'asthma', submittedAt: '2026-10-02T18:00:00.000Z' })
    expect(criticalMisses([first, other])[0].resolved).toBe(false)
  })
})

describe('retrieval', () => {
  it('withholds recall below the limited tier and reports expected beside observed recall above it', () => {
    expect(retentionResult([retention('2026-10-06T19:00:00.000Z', true)]).recall).toMatchObject({ value: null, n: 1, sufficiency: 'insufficient' })
    const many = Array.from({ length: 6 }, (_, i) => retention(`2026-10-0${i + 1}T19:00:00.000Z`, i !== 0, `card-${i % 3}`))
    const r = retentionResult(many)
    expect(r.recall).toMatchObject({ value: 0.833, n: 6, successes: 5, sufficiency: 'limited' })
    expect(r.expectedRecall).toBe(0.9)
    expect(r.distinctCards).toBe(3)
  })
})

describe('coverage', () => {
  it('separates categories with no authored case from ones not yet attempted', () => {
    const c = coverageResult([attempt({ scenarioId: 'asthma', submittedAt: '2026-10-06T18:00:00.000Z' })], bp, items)
    const status = (cid: string) => c.categories.find((x) => x.id === cid)!.status
    expect(status('pulmonary-system')).toBe('attempted')
    expect(status('cardiovascular-system')).toBe('not-attempted')
    expect(status('dermatologic-system')).toBe('not-authored')
    expect(c.weightByStatus).toEqual({ attempted: 9, 'not-attempted': 11 + 6 + 7 + 6, 'not-authored': 100 - 9 - 30 })
  })
})

describe('priorities', () => {
  it('for a new student, points to the heaviest authored categories', () => {
    const p = buildDashboard(inputs()).priorities
    expect(p.map((x) => [x.kind, x.title])).toEqual([
      ['coverage-gap', 'Start on Cardiovascular System'],
      ['coverage-gap', 'Start on Pulmonary System'],
    ])
    expect(p[0].nextAction).toEqual({ label: 'Practice Chest pressure with sweating', href: '/encounter/chest-pressure' })
    expect(p[0].why).toBe('Cardiovascular System is 11% of the PANCE blueprint. 1 published case covers it and you have not attempted one yet.')
  })

  it('ranks by kind, caps each kind at two, and is stable across runs and input order', () => {
    const crit = (rubricItemId: string, scenarioId: string, day: number) =>
      attempt({ scenarioId, submittedAt: `2026-10-0${day}T18:00:00.000Z`, misses: [miss({ phase: 'treatment', kind: 'critical', errorType: 'unsafe-action', rubricItemId, label: rubricItemId })] })
    const attempts = [crit('c1', 'chest-pressure', 1), crit('c2', 'asthma', 2), crit('c3', 'metabolic', 3)]
    const due = Array.from({ length: 7 }, (_, i) => ({ cardId: `card-${i}`, label: `Card ${i}`, due: '2026-10-11T12:00:00.000Z' }))
    const run = () => buildDashboard(inputs({ attempts, due })).priorities
    const p = run()
    expect(p.map((x) => x.kind)).toEqual(['critical-safety', 'critical-safety', 'due-retrieval'])
    // Most recent critical miss first.
    expect(p.map((x) => x.nextAction.href)).toEqual(['/encounter/metabolic', '/encounter/asthma', '/review'])
    expect(p[2]).toMatchObject({ title: 'Review 7 due cards', nextAction: { label: 'Start a quick 5' } })
    expect(run()).toEqual(p)
    expect(buildDashboard(inputs({ attempts: shuffle(attempts), due: shuffle(due) })).priorities).toEqual(p)
  })

  it('selects a weak area with enough evidence and names a case, preferring the one played longest ago', () => {
    const attempts = [
      attempt({ scenarioId: 'respiratory', submittedAt: '2026-10-01T18:00:00.000Z', misses: [miss({ phase: 'history' })] }),
      attempt({ scenarioId: 'asthma', submittedAt: '2026-10-02T18:00:00.000Z', misses: [miss({ phase: 'history' })] }),
      attempt({ scenarioId: 'asthma', submittedAt: '2026-10-03T18:00:00.000Z' }),
    ]
    const weak = buildDashboard(inputs({ attempts })).priorities.find((x) => x.kind === 'weak-area' && x.title === 'Strengthen Pulmonary System')!
    expect(weak.why).toBe('2 of your 3 attempts across 2 cases had a miss in Pulmonary System (67%; limited evidence). It is 9% of the PANCE blueprint.')
    expect(weak.nextAction).toEqual({ label: 'Practice Cough and sore throat', href: '/encounter/respiratory' })
    expect(weak.basis).toEqual({ n: 3, unit: 'attempts', sufficiency: 'limited' })
  })

  it('flags an error type recorded in two attempts and links to the latest debrief miss', () => {
    const attempts = [
      attempt({ scenarioId: 'asthma', submittedAt: '2026-10-01T18:00:00.000Z', misses: [miss({ phase: 'diagnosis', errorType: 'premature-closure', rubricItemId: 'pc-1' })] }),
      attempt({ scenarioId: 'respiratory', submittedAt: '2026-10-02T18:00:00.000Z', misses: [miss({ phase: 'diagnosis', errorType: 'premature-closure', rubricItemId: 'pc-2', label: 'Chose pneumonia' })] }),
    ]
    const priority = priorities({
      attempts,
      areas: [],
      critical: [],
      errorTypes: buildDashboard(inputs({ attempts })).errorTypes,
      workload: workloadResult([], NOW, TZ),
      coverage: { ...coverageResult([], bp, []), categories: [] },
      caseTitles: {},
      blueprintLabel: 'PANCE',
    })
    expect(priority).toHaveLength(1)
    expect(priority[0]).toMatchObject({ kind: 'recurring-error', title: 'Work on a repeated pattern: Closed too early' })
    expect(priority[0].why).toBe('"Closed too early" was recorded 2 times across 2 different attempts. The most recent was "Chose pneumonia" in Cough and sore throat.')
    expect(priority[0].nextAction.href).toBe(`/results/${attempts[1].attemptId}#miss-pc-2`)
  })
})

describe('readiness', () => {
  it('is never estimated', () => {
    const dash = buildDashboard(inputs({ attempts: [attempt({ scenarioId: 'asthma', submittedAt: '2026-10-06T18:00:00.000Z' })] }))
    expect(dash.readiness).toEqual(READINESS)
    expect(dash.readiness.available).toBe(false)
    const keys = JSON.stringify(dash).match(/"[A-Za-z]+":/g) ?? []
    expect(keys.filter((k) => /probab|predict|percentile|readinessScore|passChance/i.test(k))).toEqual([])
  })
})
