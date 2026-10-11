import type { PublicBlueprintSummary, PublicCoverage, PublicSprint, PublicStudyPlan, PublicTaxonomy, SprintAnswerResult, StudyMode } from '../../src/api/contracts'
import { deriveMisses } from '../../src/domain/remediation/misses'
import { blueprintLifecycle, isoDay } from '../../src/domain/study/blueprints'
import { alignmentClaim, computeCoverage, fullExamGate, itemsInScope, matchesCrosswalk, type StudyItem } from '../../src/domain/study/coverage'
import { observationsFor, rankPairs, type Observation } from '../../src/domain/study/recommend'
import type { Blueprint } from '../../src/domain/study/schema'
import { activeTerms, canonicalTags, type ItemTags } from '../../src/domain/study/taxonomy'
import type { TaxonomyTerm } from '../../src/domain/schema'
import type { ScenarioDefinition } from '../../src/domain/types'
import * as attempts from '../attempts/repository'
import { selectionsOf } from '../attempts/service'
import type { AuthContext } from '../auth/context'
import { contentPackage } from '../content/scenarios'
import { currentScenarios } from '../content/versions'
import { getPool } from '../db/pool'
import { ApiError } from '../http/errors'
import { now } from '../lib/clock'
import { dueKnowledge } from '../review/service'

const today = () => isoDay(now())
const vocab = () => contentPackage().taxonomy

export const RANKING_METHOD =
  'Each blueprint pair is scored as weakness x weight. Weakness is the share of your submitted attempts with a miss in the matching encounter phase (history and exam, diagnostics, diagnosis, or treatment), smoothed so a pair with no attempts counts as 50%. Pairs alternate so the same system or task does not repeat back to back. This is a study heuristic, not a validated prediction of exam performance.'

/** Published, non-retired cases as study items, with canonical tags. */
export function studyItems(): StudyItem[] {
  return currentScenarios().map((s) => ({
    id: s.id,
    title: s.summary.title,
    kind: 'case',
    tags: canonicalTags(s.taxonomy, vocab()),
    status: s.lifecycle.status,
    blueprintReviews: s.taxonomy.blueprintReviews ?? [],
  }))
}

export function publicTaxonomy(): PublicTaxonomy {
  const pick = (terms: TaxonomyTerm[]) => activeTerms(terms).map(({ id, label }) => ({ id, label }))
  return { organSystems: pick(vocab().organSystems), panceTasks: pick(vocab().panceTasks), eorRotations: pick(vocab().eorRotations) }
}

function summaryOf(bp: Blueprint, all: Blueprint[], day: string): PublicBlueprintSummary {
  return {
    id: bp.id,
    issuer: bp.issuer,
    exam: bp.exam,
    rotation: bp.rotation,
    title: bp.title,
    versionLabel: bp.versionLabel,
    lifecycle: blueprintLifecycle(bp, all, day),
    effectiveFrom: bp.effectiveFrom,
    effectiveUntil: bp.effectiveUntil,
    dateNotes: bp.dateNotes,
    source: { ...bp.source },
    transcriptionVerified: Boolean(bp.transcription.verifiedBy),
    examItems: bp.examStructure.items,
    notes: [...bp.notes],
  }
}

export function listBlueprints(): PublicBlueprintSummary[] {
  const all = contentPackage().blueprints
  const day = today()
  return all.map((b) => summaryOf(b, all, day)).sort((a, b) => a.id.localeCompare(b.id))
}

function blueprintById(id: string): Blueprint {
  const bp = contentPackage().blueprints.find((b) => b.id === id)
  if (!bp) throw new ApiError('Blueprint not found.', 404, 'blueprint_not_found')
  return bp
}

export function coverageFor(id: string): PublicCoverage {
  const bp = blueprintById(id)
  const all = contentPackage().blueprints
  const items = studyItems()
  const scoped = itemsInScope(bp, items)
  return {
    blueprint: summaryOf(bp, all, today()),
    coverage: computeCoverage(bp, items),
    secondaryTargets: (bp.secondaryTargets ?? []).map((t) => ({
      id: t.id,
      label: t.label,
      partition: t.partition,
      values: t.values.map((v) => ({ id: v.id, label: v.label, minPct: v.minPct, maxPct: v.maxPct, itemIds: scoped.filter((i) => matchesCrosswalk(i.tags, v.crosswalk)).map((i) => i.id) })),
    })),
    items: items.map((i) => ({ id: i.id, title: i.title })),
    fullExam: fullExamGate(bp, items),
    alignment: alignmentClaim(bp, items),
  }
}

/**
 * Per-task outcomes for each submitted attempt, recomputed from the pinned content snapshot and confirmed
 * selections. Tags come from that snapshot (resolved through the current vocabulary), so a later re-tag of
 * the case never rewrites what an old attempt counted toward.
 */
async function observations(userId: string): Promise<{ observations: Observation[]; attempts: number }> {
  const { rows } = await getPool().query<{ id: string; content_version_id: string }>(
    "SELECT id, content_version_id FROM attempts WHERE user_id = $1 AND status = 'submitted' ORDER BY submitted_at",
    [userId],
  )
  const out: Observation[] = []
  for (const row of rows) {
    const scenario: ScenarioDefinition = await attempts.getContentDefinition(getPool(), row.content_version_id)
    const tags: ItemTags = canonicalTags(scenario.taxonomy, vocab())
    const misses = deriveMisses(scenario, selectionsOf(await attempts.listLiveEvents(getPool(), row.id)))
    out.push(...observationsFor(row.id, tags, misses.map((m) => m.phase)))
  }
  return { observations: out, attempts: rows.length }
}

export async function studyPlan(auth: AuthContext, query: { mode: StudyMode; blueprint: string; timeZone: string }): Promise<PublicStudyPlan> {
  const bp = blueprintById(query.blueprint)
  if (query.mode === 'rotation' && bp.exam !== 'eor') throw new ApiError('Rotation mode needs an End of Rotation blueprint.', 400, 'invalid_query')
  if (query.mode === 'pance' && bp.exam !== 'pance') throw new ApiError('PANCE mode needs the PANCE blueprint.', 400, 'invalid_query')
  if (blueprintLifecycle(bp, contentPackage().blueprints, today()) === 'retired') throw new ApiError('This blueprint version is retired.', 410, 'blueprint_retired')
  const { observations: obs, attempts: n } = await observations(auth.userId)
  const library = contentPackage().knowledge
  const due = await dueKnowledge(auth, query.timeZone)
  const dueRemediation = due
    .filter((d) => {
      const kc = library?.components.find((c) => c.id === d.kcId)
      if (!kc) return false
      const tags: ItemTags = { organSystems: kc.organSystems, panceTasks: kc.panceTasks, topicTags: [], careSettings: [], ageGroups: [], eorRotations: [] }
      return bp.contentCategories.some((c) => matchesCrosswalk(tags, c.crosswalk))
    })
    .map(({ cardId, label, due: at }) => ({ cardId, label, due: at }))
  return { blueprintId: bp.id, mode: query.mode, pairs: rankPairs(bp, obs, studyItems()), basis: { submittedAttempts: n, method: RANKING_METHOD }, dueRemediation }
}

// ---- Differential sprints ----

async function submittedScenarioIds(userId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ scenario_id: string }>("SELECT DISTINCT scenario_id FROM attempts WHERE user_id = $1 AND status = 'submitted'", [userId])
  return new Set(rows.map((r) => r.scenario_id))
}

function sprintParts(id: string) {
  const pkg = contentPackage()
  const sprint = pkg.sprints.find((s) => s.id === id && s.status !== 'retired')
  const scenario = sprint && currentScenarios().find((s) => s.id === sprint.sourceScenarioId)
  if (!sprint || !scenario) throw new ApiError('Sprint not found.', 404, 'sprint_not_found')
  return { sprint, scenario }
}

/** Options are shown alphabetically so the authored order (which may start with the answer) never leaks it. */
const optionsOf = (scenario: ScenarioDefinition, ids: string[]) =>
  ids.map((id) => scenario.diagnoses.find((d) => d.id === id)!).map((d) => ({ id: d.id, label: d.label })).sort((a, b) => a.label.localeCompare(b.label))

export async function listSprints(auth: AuthContext): Promise<PublicSprint[]> {
  const done = await submittedScenarioIds(auth.userId)
  return contentPackage()
    .sprints.filter((s) => s.status !== 'retired')
    .flatMap((sp) => {
      const scenario = currentScenarios().find((s) => s.id === sp.sourceScenarioId)
      if (!scenario) return []
      const locked = !done.has(scenario.id)
      const actions = new Map(scenario.phases.flatMap((p) => p.actions.map((a) => [a.id, a] as const)))
      const tags = canonicalTags(scenario.taxonomy, vocab())
      return [{
        id: sp.id,
        sourceScenarioId: scenario.id,
        sourceTitle: scenario.summary.title,
        locked,
        draft: true,
        stem: locked ? null : `${scenario.patient.demographics}. ${scenario.summary.complaint}`,
        findings: locked ? [] : sp.findingActionIds.map((id) => ({ label: actions.get(id)!.label, text: actions.get(id)!.response })),
        options: locked ? [] : optionsOf(scenario, sp.optionIds),
        tags: { organSystems: tags.organSystems, panceTasks: tags.panceTasks, eorRotations: tags.eorRotations },
      }]
    })
}

/** Scored on the server so the answer never ships before the learner commits. Nothing is stored. */
export async function answerSprint(auth: AuthContext, id: string, optionId: string): Promise<SprintAnswerResult> {
  const { sprint, scenario } = sprintParts(id)
  if (!(await submittedScenarioIds(auth.userId)).has(scenario.id)) throw new ApiError('Finish the source case first; this drill reveals its diagnosis.', 409, 'sprint_locked')
  if (!sprint.optionIds.includes(optionId)) throw new ApiError('That is not an option in this sprint.', 400, 'invalid_body')
  const label = (dx: string) => scenario.diagnoses.find((d) => d.id === dx)!.label
  return {
    correct: optionId === scenario.correctPrimary,
    chosen: { id: optionId, label: label(optionId) },
    answer: { id: scenario.correctPrimary, label: label(scenario.correctPrimary) },
    reasoning: optionsOf(scenario, sprint.optionIds).map((o) => ({ ...o, text: scenario.diagnoses.find((d) => d.id === o.id)?.reasoning ?? null })),
  }
}
