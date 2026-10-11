import { possibleMissItems } from '../../src/domain/remediation/misses'
import { knowledgeLibrarySchema, scenarioRemediationSchema } from '../../src/domain/remediation/schema'
import type { KnowledgeLibrary, ScenarioRemediation } from '../../src/domain/remediation/types'
import type { ContentLock, TaxonomyVocabulary } from '../../src/domain/schema'
import type { ScenarioDefinition } from '../../src/domain/types'
import { canonicalJson, sha256 } from './hash'
import type { Issue } from './validate'

const MAX_EXPLANATION = 300
const MAX_PROMPT_TEXT = 400

export interface ValidatedRemediation {
  knowledge: KnowledgeLibrary | null
  /** Authored remediation by scenario id. Cases without an entry show "not yet authored". */
  remediation: Record<string, ScenarioRemediation>
}

/**
 * Fingerprint of a remediation sidecar plus the library entries it uses, so editing a used
 * knowledge component also requires a remediationVersion bump.
 */
export function remediationFingerprint(r: ScenarioRemediation, library: KnowledgeLibrary): string {
  const kcIds = new Set([...Object.values(r.mappings).flatMap((m) => m.kcIds), ...r.prompts.map((p) => p.kcId)])
  const components = library.components.filter((c) => kcIds.has(c.id))
  const objectiveIds = new Set(components.flatMap((c) => c.objectiveIds))
  const objectives = library.objectives.filter((o) => objectiveIds.has(o.id))
  return sha256(canonicalJson({ remediation: r, components, objectives }))
}

function zodToIssues(prefix: string, error: { issues: { path: PropertyKey[]; message: string }[] }, scenarioId?: string): Issue[] {
  return error.issues.map((i) => ({ severity: 'error', code: 'remediation-schema', scenarioId, path: [prefix, ...i.path.map(String)].join('.'), message: i.message }))
}

export function validateRemediation(
  raw: { knowledge: unknown; remediation: Record<string, unknown> },
  scenarios: ScenarioDefinition[],
  vocab: TaxonomyVocabulary | null,
  lock: ContentLock | null,
  options: { strict?: boolean },
  issues: Issue[],
): ValidatedRemediation {
  const out: ValidatedRemediation = { knowledge: null, remediation: {} }
  if (raw.knowledge === undefined) return out
  const add = (severity: Issue['severity'], code: string, path: string, message: string, scenarioId?: string) => issues.push({ severity, code, scenarioId, path, message })

  const lib = knowledgeLibrarySchema.safeParse(raw.knowledge)
  if (!lib.success) {
    issues.push(...zodToIssues('knowledge', lib.error))
    return out
  }
  const library = lib.data as KnowledgeLibrary
  const objectiveIds = new Set<string>()
  library.objectives.forEach((o, i) => {
    if (objectiveIds.has(o.id)) add('error', 'duplicate-id', `knowledge.objectives.${i}`, `Objective "${o.id}" is defined twice.`)
    objectiveIds.add(o.id)
  })
  const kcIds = new Set<string>()
  library.components.forEach((c, i) => {
    const path = `knowledge.components.${i}`
    if (kcIds.has(c.id)) add('error', 'duplicate-id', path, `Knowledge component "${c.id}" is defined twice.`)
    kcIds.add(c.id)
    for (const o of c.objectiveIds) if (!objectiveIds.has(o)) add('error', 'remediation-ref', `${path}.objectiveIds`, `"${o}" is not a learning objective.`)
  })
  if (vocab) {
    // Deprecated IDs resolve for stored data only; authored library content must use active terms.
    const pance = new Set(vocab.panceTasks.filter((t) => t.status === 'active').map((t) => t.id))
    const organ = new Set(vocab.organSystems.filter((t) => t.status === 'active').map((t) => t.id))
    library.objectives.forEach((o, i) => o.panceTasks.forEach((t) => !pance.has(t) && add('error', 'taxonomy-term', `knowledge.objectives.${i}.panceTasks`, `"${t}" is not an active term in content/taxonomy.json.`)))
    library.components.forEach((c, i) => {
      c.panceTasks.forEach((t) => !pance.has(t) && add('error', 'taxonomy-term', `knowledge.components.${i}.panceTasks`, `"${t}" is not an active term in content/taxonomy.json.`))
      c.organSystems.forEach((t) => !organ.has(t) && add('error', 'taxonomy-term', `knowledge.components.${i}.organSystems`, `"${t}" is not an active term in content/taxonomy.json.`))
    })
  }
  out.knowledge = library

  const promptOwners = new Map<string, string>()
  for (const [stem, input] of Object.entries(raw.remediation)) {
    if (input === undefined) continue
    const parsed = scenarioRemediationSchema.safeParse(input)
    if (!parsed.success) {
      issues.push(...zodToIssues(`remediation/${stem}`, parsed.error, stem))
      continue
    }
    const r = parsed.data as ScenarioRemediation
    const sid = r.scenarioId
    const at = (path: string) => `remediation/${stem}.${path}`
    const before = issues.filter((i) => i.severity === 'error').length
    if (stem !== sid) add('error', 'id-mismatch', at('scenarioId'), `File remediation/${stem}.json declares scenario "${sid}".`, sid)
    const s = scenarios.find((x) => x.id === sid)
    if (!s) {
      add('error', 'remediation-ref', at('scenarioId'), `"${sid}" is not a scenario in the manifest.`, sid)
      continue
    }

    // Every rubric item that can become a miss must be mapped, so every graded miss is traceable.
    const possible = new Set(possibleMissItems(s))
    for (const item of possible) if (!r.mappings[item]) add('error', 'remediation-unmapped', at('mappings'), `Rubric item "${item}" can be missed but has no mapping.`, sid)
    for (const [item, m] of Object.entries(r.mappings)) {
      if (!possible.has(item)) add('error', 'remediation-stale-mapping', at(`mappings.${item}`), `"${item}" is not a rubric item that can be missed in this case.`, sid)
      for (const kc of m.kcIds) if (!kcIds.has(kc)) add('error', 'remediation-ref', at(`mappings.${item}.kcIds`), `"${kc}" is not a knowledge component in knowledge/library.json.`, sid)
    }

    const mappedKcs = new Set(Object.values(r.mappings).flatMap((m) => m.kcIds))
    r.prompts.forEach((p, i) => {
      const path = at(`prompts.${i}`)
      const owner = promptOwners.get(p.id)
      if (owner) add('error', 'duplicate-id', path, `Prompt "${p.id}" is already used in remediation/${owner}.json. Prompt IDs are global.`, sid)
      promptOwners.set(p.id, stem)
      if (!kcIds.has(p.kcId)) add('error', 'remediation-ref', `${path}.kcId`, `"${p.kcId}" is not a knowledge component.`, sid)
      else if (!mappedKcs.has(p.kcId)) add('warning', 'remediation-unused-prompt', `${path}.kcId`, `No mapping in this case uses "${p.kcId}", so this prompt is never shown.`, sid)
      if (p.explanation.length > MAX_EXPLANATION) add('error', 'teaching-length', `${path}.explanation`, `Keep explanations concise (${MAX_EXPLANATION} characters maximum; this is ${p.explanation.length}).`, sid)
      for (const [field, value] of [['front', p.front], ['answer', p.answer], ['explanation', p.explanation], ...(p.choices ?? []).map((c, ci) => [`choices.${ci}`, c])] as const) {
        if (/https?:\/\//i.test(value)) add('error', 'teaching-url', `${path}.${field}`, 'Put sources in clinicalReferences, not in review prompts.', sid)
        if (value.length > MAX_PROMPT_TEXT) add('error', 'teaching-length', `${path}.${field}`, `Prompt text is limited to ${MAX_PROMPT_TEXT} characters.`, sid)
      }
      if ((p.type === 'discrimination' || p.type === 'differential') && !p.choices) add('error', 'remediation-prompt', `${path}.choices`, `A ${p.type} prompt needs choices to discriminate between.`, sid)
    })
    for (const kc of mappedKcs) {
      const types = new Set(r.prompts.filter((p) => p.kcId === kc).map((p) => p.type))
      if (types.size === 0) add('error', 'remediation-no-prompt', at('prompts'), `Knowledge component "${kc}" is mapped but has no prompt in this file.`, sid)
      else if (types.size < 2) add('warning', 'remediation-variety', at('prompts'), `"${kc}" has only ${[...types][0]} prompts; add another type for variety.`, sid)
    }

    if (lock) {
      const fp = remediationFingerprint(r, library)
      const mine = (lock.remediation ?? []).filter((e) => e.scenarioId === sid)
      const exact = mine.find((e) => e.remediationVersion === r.remediationVersion)
      if (exact && exact.fingerprint !== fp) add('error', 'lock-mismatch', at('remediationVersion'), `Remediation changed since ${exact.remediationVersion} was locked. Bump remediationVersion, then run npm run content:lock.`, sid)
      if (!exact) add(options.strict ? 'error' : 'warning', 'lock-missing', at('remediationVersion'), `Remediation ${r.remediationVersion} is not in content/lock.json. Run npm run content:lock once it is final.`, sid)
    }
    if (issues.filter((i) => i.severity === 'error').length === before) out.remediation[sid] = r
  }
  if (lock) {
    for (const e of lock.remediation ?? []) {
      if (!(e.scenarioId in raw.remediation)) add('error', 'lock-orphan', 'lock.remediation', `"${e.scenarioId}" has locked remediation but no remediation file.`)
    }
  }
  return out
}
