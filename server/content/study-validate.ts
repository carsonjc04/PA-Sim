import type { ContentManifest, TaxonomyVocabulary } from '../../src/domain/schema'
import { blueprintSchema, sprintSchema, taxonomyHistorySchema, type Blueprint, type Crosswalk, type SprintDefinition, type TaxonomyHistory } from '../../src/domain/study/schema'
import type { ScenarioDefinition } from '../../src/domain/types'
import type { RawPackage } from './loader'
import type { Issue } from './validate'

export interface ValidatedStudyContent {
  blueprints: Blueprint[]
  sprints: SprintDefinition[]
  taxonomyHistory: TaxonomyHistory | null
}

const AXES = ['organSystems', 'panceTasks', 'topicTags', 'careSettings', 'ageGroups', 'eorRotations'] as const
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentions = (haystack: string, term: string) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(term.toLowerCase())}($|[^a-z0-9])`).test(haystack.toLowerCase())
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9

type Add = (severity: Issue['severity'], code: string, path: string, message: string, scenarioId?: string) => void

/** The taxonomy only grows: every ID ever published stays, and deprecated IDs point at active replacements. */
function checkTaxonomyHistory(raw: unknown, vocab: TaxonomyVocabulary, add: Add): TaxonomyHistory | null {
  const parsed = taxonomyHistorySchema.safeParse(raw)
  if (!parsed.success) {
    for (const i of parsed.error.issues) add('error', 'taxonomy-history-schema', ['taxonomy-history', ...i.path.map(String)].join('.'), i.message)
    return null
  }
  for (const axis of AXES) {
    const terms = vocab[axis]
    const ids = new Set(terms.map((t) => t.id))
    const history = new Set(parsed.data.axes[axis])
    for (const id of history) if (!ids.has(id)) add('error', 'taxonomy-id-removed', `taxonomy.${axis}`, `"${id}" was published before and must stay in content/taxonomy.json. Deprecate it (status "deprecated" with replacedBy) instead of deleting it.`)
    for (const id of ids) if (!history.has(id)) add('error', 'taxonomy-history-stale', `taxonomy-history.axes.${axis}`, `"${id}" is new; append it to content/taxonomy-history.json.`)
    const dup = terms.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i)
    for (const id of new Set(dup)) add('error', 'taxonomy-duplicate', `taxonomy.${axis}`, `"${id}" is listed twice.`)
    for (const t of terms) {
      if (t.status === 'deprecated') {
        if (!t.replacedBy?.length) add('error', 'taxonomy-replacement', `taxonomy.${axis}.${t.id}`, `Deprecated "${t.id}" needs replacedBy so stored snapshots still resolve.`)
        for (const r of t.replacedBy ?? []) {
          const target = terms.find((x) => x.id === r)
          if (!target || target.status !== 'active') add('error', 'taxonomy-replacement', `taxonomy.${axis}.${t.id}`, `"${t.id}" is replaced by "${r}", which is not an active ${axis} term.`)
        }
      } else if (t.replacedBy) add('error', 'taxonomy-replacement', `taxonomy.${axis}.${t.id}`, `Active "${t.id}" must not have replacedBy.`)
    }
  }
  return parsed.data
}

function checkCrosswalk(cw: Crosswalk, vocab: TaxonomyVocabulary, path: string, add: Add) {
  const vocabFor = { organSystems: vocab.organSystems, panceTasks: vocab.panceTasks, topicTags: vocab.topicTags, careSettings: vocab.careSettings, ageGroups: vocab.ageGroups } as const
  cw.anyOf.forEach((clause, ci) => {
    for (const [field, terms] of Object.entries(vocabFor)) {
      for (const id of (clause as Record<string, string[] | undefined>)[field] ?? []) {
        const term = terms.find((t) => t.id === id)
        if (!term) add('error', 'blueprint-crosswalk', `${path}.anyOf.${ci}.${field}`, `"${id}" is not a ${field} term in content/taxonomy.json.`)
        else if (term.status !== 'active') add('error', 'blueprint-crosswalk-deprecated', `${path}.anyOf.${ci}.${field}`, `"${id}" is deprecated; crosswalk to ${term.replacedBy?.join(', ')} instead.`)
      }
    }
  })
}

function checkBlueprint(bp: Blueprint, vocab: TaxonomyVocabulary, now: string, add: Add) {
  const at = (p: string) => `blueprints/${bp.id}.${p}`
  if (bp.exam === 'pance' && bp.rotation !== null) add('error', 'blueprint-scope', at('rotation'), 'A PANCE blueprint has no rotation.')
  if (bp.exam === 'eor' && !vocab.eorRotations.some((r) => r.id === bp.rotation && r.status === 'active')) add('error', 'blueprint-rotation', at('rotation'), `"${bp.rotation}" is not an active EOR rotation in content/taxonomy.json.`)
  if (bp.effectiveFrom && bp.effectiveUntil && bp.effectiveFrom > bp.effectiveUntil) add('error', 'blueprint-dates', at('effectiveUntil'), 'effectiveUntil is before effectiveFrom.')
  if (bp.source.retrievedAt > now) add('error', 'blueprint-dates', at('source.retrievedAt'), 'retrievedAt is in the future.')

  const contentPct = sum(bp.contentCategories.map((c) => c.weightPct))
  const taskPct = sum(bp.taskCategories.map((t) => t.weightPct))
  if (!close(contentPct, 100)) add('error', 'blueprint-weights', at('contentCategories'), `Content weights total ${contentPct}%, not 100%.`)
  if (!close(taskPct, 100)) add('error', 'blueprint-weights', at('taskCategories'), `Task weights total ${taskPct}%, not 100%.`)
  for (const [name, list] of [['contentCategories', bp.contentCategories], ['taskCategories', bp.taskCategories]] as const) {
    const ids = list.map((x) => x.id)
    for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) add('error', 'blueprint-duplicate', at(name), `Category "${id}" appears twice.`)
  }

  bp.contentCategories.forEach((c, i) => checkCrosswalk(c.crosswalk, vocab, at(`contentCategories.${i}.crosswalk`), add))
  bp.taskCategories.forEach((t, i) => {
    const term = vocab.panceTasks.find((x) => x.id === t.canonicalTask)
    if (!term || term.status !== 'active') add('error', 'blueprint-task', at(`taskCategories.${i}.canonicalTask`), `"${t.canonicalTask}" is not an active task in content/taxonomy.json.`)
  })

  if (bp.cells) {
    const total = bp.examStructure.items
    if (total === null) add('error', 'blueprint-cells', at('examStructure.items'), 'A blueprint with an item matrix must state the exam length.')
    const contentIds = new Set(bp.contentCategories.map((c) => c.id))
    const taskIds = new Set(bp.taskCategories.map((t) => t.id))
    const seen = new Set<string>()
    for (const cell of bp.cells) {
      const key = `${cell.content}|${cell.task}`
      if (!contentIds.has(cell.content) || !taskIds.has(cell.task)) add('error', 'blueprint-cells', at('cells'), `Cell ${key} names an unknown category.`)
      if (seen.has(key)) add('error', 'blueprint-cells', at('cells'), `Cell ${key} appears twice.`)
      seen.add(key)
    }
    if (seen.size !== contentIds.size * taskIds.size) add('error', 'blueprint-cells', at('cells'), `The matrix has ${seen.size} cells; expected ${contentIds.size} x ${taskIds.size}.`)
    const items = total ?? sum(bp.cells.map((c) => c.items))
    for (const c of bp.contentCategories) {
      const row = sum(bp.cells.filter((x) => x.content === c.id).map((x) => x.items))
      if (!close((row / items) * 100, c.weightPct)) add('error', 'blueprint-cells', at(`contentCategories.${c.id}`), `Row ${c.id} has ${row} items but is stated as ${c.weightPct}%.`)
    }
    for (const t of bp.taskCategories) {
      const col = sum(bp.cells.filter((x) => x.task === t.id).map((x) => x.items))
      if (!close((col / items) * 100, t.weightPct)) add('error', 'blueprint-cells', at(`taskCategories.${t.id}`), `Column ${t.id} has ${col} items but is stated as ${t.weightPct}%.`)
    }
    if (total !== null && sum(bp.cells.map((c) => c.items)) !== total) add('error', 'blueprint-cells', at('cells'), `Cells total ${sum(bp.cells.map((c) => c.items))}, not ${total}.`)
  }
  for (const ex of bp.taskCodingExclusions ?? []) {
    if (!bp.contentCategories.some((c) => c.id === ex.content) || !bp.taskCategories.some((t) => t.id === ex.task)) add('error', 'blueprint-cells', at('taskCodingExclusions'), `Exclusion ${ex.content}|${ex.task} names an unknown category.`)
  }
  bp.secondaryTargets?.forEach((target, ti) => {
    target.values.forEach((v, vi) => {
      if (v.minPct > v.maxPct) add('error', 'blueprint-weights', at(`secondaryTargets.${ti}.values.${vi}`), 'minPct is above maxPct.')
      checkCrosswalk(v.crosswalk, vocab, at(`secondaryTargets.${ti}.values.${vi}.crosswalk`), add)
    })
    if (target.partition && !(close(sum(target.values.map((v) => v.minPct)), 100) && close(sum(target.values.map((v) => v.maxPct)), 100))) {
      add('error', 'blueprint-weights', at(`secondaryTargets.${ti}`), `Partition "${target.id}" must total 100%.`)
    }
  })
}

function checkSuccession(blueprints: Blueprint[], vocab: TaxonomyVocabulary, add: Add) {
  const byId = new Map(blueprints.map((b) => [b.id, b]))
  for (const b of blueprints) {
    if (b.supersededBy) {
      const next = byId.get(b.supersededBy)
      if (!next) add('error', 'blueprint-succession', `blueprints/${b.id}.supersededBy`, `"${b.supersededBy}" is not a blueprint.`)
      else if (!next.supersedes.includes(b.id)) add('error', 'blueprint-succession', `blueprints/${next.id}.supersedes`, `"${next.id}" must list "${b.id}" in supersedes.`)
      else if (next.exam !== b.exam || next.rotation !== b.rotation) add('error', 'blueprint-succession', `blueprints/${b.id}.supersededBy`, 'A successor must be for the same exam and rotation.')
    }
    for (const prev of b.supersedes) {
      if (byId.get(prev)?.supersededBy !== b.id) add('error', 'blueprint-succession', `blueprints/${b.id}.supersedes`, `"${prev}" must name "${b.id}" as supersededBy.`)
    }
  }
  if (!blueprints.some((b) => b.exam === 'pance')) add('error', 'blueprint-missing', 'blueprints', 'No PANCE blueprint is present.')
  for (const r of vocab.eorRotations.filter((r) => r.status === 'active')) {
    if (!blueprints.some((b) => b.rotation === r.id)) add('error', 'blueprint-missing', 'blueprints', `Rotation "${r.id}" has no blueprint.`)
  }
}

/** A sprint may only reuse what its source case already says; the case version pins that. */
function checkSprint(sp: SprintDefinition, scenarios: ScenarioDefinition[], manifest: ContentManifest, add: Add) {
  const at = (p: string) => `sprints/${sp.id}.${p}`
  const s = scenarios.find((x) => x.id === sp.sourceScenarioId)
  if (!s) return add('error', 'sprint-source', at('sourceScenarioId'), `"${sp.sourceScenarioId}" is not a case in the package.`)
  if (!manifest.scenarios.find((e) => e.id === s.id)?.published && sp.status !== 'retired') add('error', 'sprint-source', at('sourceScenarioId'), 'The source case is not published; retire the sprint.')
  if (sp.sourceContentVersion !== s.lifecycle.contentVersion) add('error', 'sprint-stale', at('sourceContentVersion'), `Checked against ${s.id}@${sp.sourceContentVersion}, but the case is now ${s.lifecycle.contentVersion}. Re-check the findings and options, then update sourceContentVersion.`)
  const actions = new Map(s.phases.filter((p) => ['history', 'exam', 'diagnostics'].includes(p.id)).flatMap((p) => p.actions.map((a) => [a.id, a] as const)))
  const terms = [...s.spoilerTerms, s.diagnoses.find((d) => d.id === s.correctPrimary)?.label ?? ''].filter((t) => t.length > 1)
  sp.findingActionIds.forEach((id, i) => {
    const a = actions.get(id)
    if (!a) return add('error', 'sprint-finding', at(`findingActionIds.${i}`), `"${id}" is not a history, exam or diagnostics action in ${s.id}.`)
    const hit = terms.find((t) => mentions(a.response, t))
    if (hit) add('error', 'sprint-spoiler', at(`findingActionIds.${i}`), `The finding for "${id}" names the answer ("${hit}").`)
  })
  if (new Set(sp.findingActionIds).size !== sp.findingActionIds.length) add('error', 'sprint-finding', at('findingActionIds'), 'Duplicate findings.')
  const diagnoses = new Set(s.diagnoses.map((d) => d.id))
  sp.optionIds.forEach((id, i) => !diagnoses.has(id) && add('error', 'sprint-options', at(`optionIds.${i}`), `"${id}" is not a diagnosis option in ${s.id}.`))
  if (!sp.optionIds.includes(s.correctPrimary)) add('error', 'sprint-options', at('optionIds'), `The options must include the case's correct diagnosis (${s.correctPrimary}).`)
  if (new Set(sp.optionIds).size !== sp.optionIds.length) add('error', 'sprint-options', at('optionIds'), 'Duplicate options.')
}

export function validateStudyContent(
  raw: RawPackage,
  scenarios: ScenarioDefinition[],
  vocab: TaxonomyVocabulary | null,
  manifest: ContentManifest | null,
  now: string,
  issues: Issue[],
): ValidatedStudyContent {
  const add: Add = (severity, code, path, message, scenarioId) => issues.push({ severity, code, path, message, scenarioId })
  const out: ValidatedStudyContent = { blueprints: [], sprints: [], taxonomyHistory: null }
  if (!vocab) return out
  out.taxonomyHistory = checkTaxonomyHistory(raw.taxonomyHistory, vocab, add)

  for (const [stem, value] of Object.entries(raw.blueprints)) {
    if (value === undefined) continue
    const parsed = blueprintSchema.safeParse(value)
    if (!parsed.success) {
      for (const i of parsed.error.issues) add('error', 'blueprint-schema', [`blueprints/${stem}`, ...i.path.map(String)].join('.'), i.message)
      continue
    }
    if (parsed.data.id !== stem) add('error', 'blueprint-id', `blueprints/${stem}.id`, `File declares id "${parsed.data.id}"; rename the file or the id.`)
    checkBlueprint(parsed.data, vocab, now, add)
    out.blueprints.push(parsed.data)
  }
  checkSuccession(out.blueprints, vocab, add)
  const unverified = out.blueprints.filter((b) => !b.transcription.verifiedBy).map((b) => b.id)
  if (unverified.length) add('warning', 'blueprint-unverified', 'blueprints', `${unverified.length} blueprint transcription(s) not yet re-checked against the source by a second person: ${unverified.join(', ')}.`)

  // Blueprint reviews on cases must name a real blueprint version.
  for (const s of scenarios) {
    s.taxonomy.blueprintReviews?.forEach((r, i) => {
      if (!out.blueprints.some((b) => b.id === r.blueprintId)) add('error', 'taxonomy-blueprint-review', `taxonomy.blueprintReviews.${i}`, `"${r.blueprintId}" is not a blueprint ID.`, s.id)
    })
  }

  for (const [stem, value] of Object.entries(raw.sprints)) {
    if (value === undefined) continue
    const parsed = sprintSchema.safeParse(value)
    if (!parsed.success) {
      for (const i of parsed.error.issues) add('error', 'sprint-schema', [`sprints/${stem}`, ...i.path.map(String)].join('.'), i.message)
      continue
    }
    if (parsed.data.id !== stem) add('error', 'sprint-id', `sprints/${stem}.id`, `File declares id "${parsed.data.id}".`)
    if (manifest) checkSprint(parsed.data, scenarios, manifest, add)
    out.sprints.push(parsed.data)
  }
  return out
}
