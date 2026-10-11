import { GRADING_VERSION, gradeAttempt } from '../../src/domain/grading'
import {
  type ContentLock,
  type ContentManifest,
  type ScenarioFixtureFile,
  type TaxonomyVocabulary,
  lockSchema,
  manifestSchema,
  phaseIds,
  safeParseScenario,
  scenarioFixtureFile,
  taxonomyVocabularySchema,
} from '../../src/domain/schema'
import { type Attempt, type ScenarioDefinition, QUALIFIED_REVIEWER_ROLES } from '../../src/domain/types'
import { contentFingerprint } from './hash'
import type { RawPackage } from './loader'
import { validateRemediation, type ValidatedRemediation } from './remediation'

export interface Issue {
  severity: 'error' | 'warning'
  code: string
  scenarioId?: string
  path: string
  message: string
}

export interface ValidatedPackage extends ValidatedRemediation {
  manifest: ContentManifest
  lock: ContentLock
  taxonomy: TaxonomyVocabulary
  scenarios: ScenarioDefinition[]
  fixtures: Record<string, ScenarioFixtureFile>
}

export interface ValidationResult {
  issues: Issue[]
  errors: Issue[]
  warnings: Issue[]
  /** Present only when the package has no errors. */
  package: ValidatedPackage | null
}

export interface ValidateOptions {
  now?: Date
  /** Unlocked versions become errors. Used by the build and by production startup. */
  strict?: boolean
  gradingVersion?: string
}

const MAX_TEACHING_TEXT = 300
const REVIEW_INTERVAL_DAYS = 366

const textOf = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' ')
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentions = (haystack: string, term: string) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(term.toLowerCase())}($|[^a-z0-9])`).test(haystack.toLowerCase())
const cmpSemver = (a: string, b: string) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000

function zodIssues(prefix: string, error: { issues: { path: PropertyKey[]; message: string }[] }, scenarioId?: string): Issue[] {
  return error.issues.map((i) => ({
    severity: 'error',
    code: 'schema',
    scenarioId,
    path: [prefix, ...i.path.map(String)].join('.'),
    message: i.message,
  }))
}

interface Collector {
  add(severity: Issue['severity'], code: string, path: string, message: string): void
}

function collectorFor(issues: Issue[], scenarioId?: string): Collector {
  return { add: (severity, code, path, message) => issues.push({ severity, code, scenarioId, path, message }) }
}

/** Every ID in a scenario, with where it lives. IDs are unique across the whole case. */
function indexIds(s: ScenarioDefinition, c: Collector) {
  const seen = new Map<string, string>()
  const claim = (id: string, where: string) => {
    const prior = seen.get(id)
    if (prior) c.add('error', 'duplicate-id', where, `ID "${id}" is already used at ${prior}. IDs must be unique across the whole case.`)
    else seen.set(id, where)
  }
  s.phases.forEach((p, pi) => p.actions.forEach((a, ai) => claim(a.id, `phases.${pi}.actions.${ai}`)))
  s.diagnoses.forEach((d, i) => claim(d.id, `diagnoses.${i}`))
  s.planOptions.forEach((p, i) => claim(p.id, `planOptions.${i}`))
  s.omissions.forEach((o, i) => claim(o.id, `omissions.${i}`))
  s.criticalRules.forEach((r, i) => claim(r.id, `criticalRules.${i}`))
  s.clinicalImages?.forEach((m, i) => claim(m.id, `clinicalImages.${i}`))
}

function checkPhases(s: ScenarioDefinition, c: Collector) {
  const ids = s.phases.map((p) => p.id)
  if (ids.length !== phaseIds.length || ids.some((id, i) => id !== phaseIds[i])) {
    c.add('error', 'phases-incomplete', 'phases', `Phases must be exactly ${phaseIds.join(', ')} in that order; found ${ids.join(', ') || 'none'}.`)
  }
  for (const p of s.phases) {
    const idx = s.phases.indexOf(p)
    if (['history', 'exam', 'diagnostics'].includes(p.id) && p.actions.length === 0) {
      c.add('error', 'phase-empty', `phases.${idx}.actions`, `The ${p.id} phase needs at least one action.`)
    }
    if (['diagnosis', 'treatment'].includes(p.id) && p.actions.length > 0) {
      c.add('error', 'unreachable-actions', `phases.${idx}.actions`, `The ${p.id} phase is answered from ${p.id === 'diagnosis' ? 'diagnoses' : 'planOptions'}; actions listed here can never be selected.`)
    }
    if (!s.phases[idx].description.trim()) c.add('error', 'phase-empty', `phases.${idx}.description`, 'Phase description is empty.')
  }
  if (s.diagnoses.length < 2) c.add('error', 'diagnosis-options', 'diagnoses', 'At least two diagnosis options are needed so the answer is a choice.')
  for (const group of ['treatment', 'disposition'] as const) {
    if (!s.planOptions.some((p) => p.group === group)) c.add('error', 'plan-group-missing', 'planOptions', `At least one "${group}" plan option is required.`)
  }
}

function checkRubric(s: ScenarioDefinition, c: Collector) {
  const actionPhase = new Map<string, string>()
  s.phases.forEach((p) => p.actions.forEach((a) => actionPhase.set(a.id, p.id)))
  const diagnosisIds = new Set(s.diagnoses.map((d) => d.id))
  const planIds = new Set(s.planOptions.map((p) => p.id))

  if (!diagnosisIds.has(s.correctPrimary)) c.add('error', 'rubric-ref', 'correctPrimary', `correctPrimary "${s.correctPrimary}" is not a diagnosis ID.`)
  const primaries = s.diagnoses.filter((d) => d.primary)
  if (primaries.length !== 1 || primaries[0].id !== s.correctPrimary) {
    c.add('error', 'rubric-ref', 'diagnoses', 'Exactly one diagnosis must have primary: true and it must equal correctPrimary.')
  }

  s.omissions.forEach((o, i) => {
    for (const w of o.when) {
      const owner = o.phase === 'diagnosis' ? (diagnosisIds.has(w) ? 'diagnosis' : undefined) : o.phase === 'treatment' ? (planIds.has(w) ? 'treatment' : undefined) : actionPhase.get(w)
      if (owner !== o.phase) c.add('error', 'rubric-ref', `omissions.${i}.when`, `Omission "${o.id}" is in phase ${o.phase} but "${w}" is ${owner ? `in ${owner}` : 'not an ID in this case'}.`)
    }
  })

  const negative = (effects?: { points: number }[]) => (effects ?? []).reduce((n, e) => n + e.points, 0) < 0
  const actions = new Map(s.phases.flatMap((p) => p.actions.map((a) => [a.id, a] as const)))
  s.criticalRules.forEach((r, i) => {
    for (const w of r.when) {
      const action = actions.get(w)
      const plan = s.planOptions.find((p) => p.id === w)
      if (!action && !plan) {
        c.add('error', 'critical-target', `criticalRules.${i}.when`, `Critical rule "${r.id}" targets "${w}", which is not an action or plan option in this case.`)
      } else if (plan ? !(plan.unsafe || negative(plan.effects)) : !(action?.unsafeReason || negative(action?.effects))) {
        c.add('error', 'critical-target', `criticalRules.${i}.when`, `Critical rule "${r.id}" targets "${w}", which is neither flagged unsafe nor negatively scored.`)
      }
    }
  })

  const covered = new Set(s.criticalRules.flatMap((r) => r.when))
  const waived = new Map(s.criticalWaivers.map((w) => [w.optionId, w]))
  s.planOptions.forEach((p, i) => {
    if (!p.unsafe) return
    if (!p.unsafeReason) c.add('error', 'unsafe-reason', `planOptions.${i}`, `Unsafe plan option "${p.id}" needs an unsafeReason.`)
    if (!covered.has(p.id) && !waived.has(p.id)) {
      c.add('error', 'unsafe-uncovered', `planOptions.${i}`, `Unsafe plan option "${p.id}" has no critical rule and no criticalWaiver.`)
    }
  })
  s.criticalWaivers.forEach((w, i) => {
    const plan = s.planOptions.find((p) => p.id === w.optionId)
    if (!plan?.unsafe) c.add('error', 'waiver-target', `criticalWaivers.${i}`, `Waiver "${w.optionId}" does not name an unsafe plan option.`)
    else if (covered.has(w.optionId)) c.add('warning', 'waiver-stale', `criticalWaivers.${i}`, `"${w.optionId}" is now covered by a critical rule; remove the waiver.`)
  })
  s.diagnoses.forEach((d, i) => {
    if (d.id !== s.correctPrimary && d.effects.some((e) => e.points > 10)) c.add('warning', 'rubric-weight', `diagnoses.${i}`, `Distractor "${d.id}" earns more than 10 points; check the rubric.`)
  })
}

/** Static checks for ActionRule. The runtime engine is a later milestone; this keeps authored rules coherent. */
function checkRules(s: ScenarioDefinition, c: Collector) {
  const order = new Map<string, number>()
  s.phases.forEach((p, pi) => p.actions.forEach((a) => order.set(a.id, pi)))
  const actions = s.phases.flatMap((p, pi) => p.actions.map((a, ai) => ({ a, path: `phases.${pi}.actions.${ai}.rule`, phase: pi })))
  const byId = new Map(actions.map((x) => [x.a.id, x]))

  for (const { a, path, phase } of actions) {
    const rule = a.rule
    if (!rule) continue
    for (const key of ['requires', 'excludes', 'unlocks', 'hides'] as const) {
      for (const target of rule[key] ?? []) {
        if (!byId.has(target)) c.add('error', 'rule-target', `${path}.${key}`, `"${a.id}" ${key} "${target}", which is not an action in this case.`)
        else if (target === a.id) c.add('error', 'rule-conflict', `${path}.${key}`, `"${a.id}" ${key} itself.`)
      }
    }
    for (const target of rule.requires ?? []) {
      const t = byId.get(target)
      if (t && t.phase > phase) c.add('error', 'rule-order', `${path}.requires`, `"${a.id}" requires "${target}", which only appears in a later phase.`)
    }
    for (const target of rule.requires ?? []) {
      if (rule.excludes?.includes(target)) c.add('error', 'rule-conflict', path, `"${a.id}" both requires and excludes "${target}".`)
    }
    for (const target of rule.unlocks ?? []) {
      if (rule.hides?.includes(target)) c.add('error', 'rule-conflict', path, `"${a.id}" both unlocks and hides "${target}".`)
    }
  }

  // Reachability: an action is reachable when everything it requires is reachable.
  const reachable = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const { a } of actions) {
      if (reachable.has(a.id)) continue
      if ((a.rule?.requires ?? []).every((r) => reachable.has(r))) {
        reachable.add(a.id)
        changed = true
      }
    }
  }
  for (const { a, path } of actions) {
    if (!reachable.has(a.id)) c.add('error', 'unreachable-action', path, `Action "${a.id}" can never be reached: its requires chain is cyclic or unsatisfiable.`)
  }

  // A prerequisite chain must be selectable together: nothing in it may exclude another member.
  for (const { a, path } of actions) {
    const chain = new Set<string>()
    const stack = [a.id]
    while (stack.length) {
      const id = stack.pop() as string
      if (chain.has(id)) continue
      chain.add(id)
      stack.push(...(byId.get(id)?.a.rule?.requires ?? []))
    }
    for (const x of chain) {
      for (const excluded of byId.get(x)?.a.rule?.excludes ?? []) {
        if (chain.has(excluded)) c.add('error', 'rule-incompatible', path, `"${a.id}" needs "${x}", which excludes "${excluded}", also needed in the same chain.`)
      }
    }
  }

  for (const o of s.omissions) {
    for (const w of o.when) {
      if (byId.has(w) && !reachable.has(w)) c.add('error', 'unreachable-action', `omissions.${o.id}`, `Omission "${o.id}" depends on "${w}", which is unreachable.`)
    }
  }
}

function attemptOf(s: ScenarioDefinition, selections: Attempt['selectedByPhase']): Attempt {
  return { id: 'validation', scenarioId: s.id, startedAt: '1970-01-01', selectedByPhase: selections, phaseLocks: [], revealed: [], submitted: true }
}

/** The authored rubric must allow a passing, safe path. Uses the real grader, so it cannot drift. */
function checkHappyPath(s: ScenarioDefinition, c: Collector) {
  const net = (e?: { points: number }[]) => (e ?? []).reduce((n, x) => n + x.points, 0)
  const critical = new Set(s.criticalRules.flatMap((r) => r.when))
  const pick = (phase: string) => s.phases.find((p) => p.id === phase)?.actions.filter((a) => net(a.effects) > 0 && !critical.has(a.id) && !a.unsafeReason).map((a) => a.id) ?? []
  const result = gradeAttempt(
    s,
    attemptOf(s, {
      history: pick('history'),
      exam: pick('exam'),
      diagnostics: pick('diagnostics'),
      diagnosis: [s.correctPrimary],
      treatment: s.planOptions.filter((p) => net(p.effects) > 0 && !p.unsafe && !critical.has(p.id)).map((p) => p.id),
    }),
  )
  if (!result.passed) c.add('error', 'no-passing-path', 'phases', `Selecting every positive, safe option does not pass (final score ${result.finalScore}). The rubric has no passing path.`)
}

function checkSpoilers(s: ScenarioDefinition, c: Collector) {
  const correct = s.diagnoses.find((d) => d.id === s.correctPrimary)
  const terms = [...s.spoilerTerms, correct?.label ?? '', s.correctPrimary.replace(/-/g, ' ')].filter((t) => t.length > 1)
  if (s.spoilerTerms.length === 0) c.add('error', 'spoiler-terms', 'spoilerTerms', 'List synonyms of the correct diagnosis in spoilerTerms (they are checked against learner-visible text).')
  const visible: [string, string][] = [
    ['summary.title', s.summary.title],
    ['summary.complaint', s.summary.complaint],
    ['patient.demographics', s.patient.demographics],
    ['opening', s.opening],
    ...s.initialInfo.map((t, i): [string, string] => [`initialInfo.${i}`, t]),
    ...(s.clinicalImages ?? []).flatMap((m, i): [string, string][] => [[`clinicalImages.${i}.alt`, m.alt], [`clinicalImages.${i}.longDescription`, m.longDescription ?? '']]),
  ]
  for (const [path, value] of visible) {
    const hit = terms.find((t) => mentions(value, t))
    if (hit) c.add('error', 'spoiler', path, `Learner-visible text names the answer ("${hit}"). Describe the presentation, not the diagnosis.`)
  }
  // Student-voice question wording may legitimately name a condition (for example in a family-history
  // question), so it is reviewed as a warning rather than rewritten or blocked.
  s.phases.forEach((p, pi) =>
    p.actions.forEach((a, ai) => {
      for (const [field, value] of [['label', a.label], ['paText', a.paText]] as const) {
        const hit = terms.find((t) => mentions(value, t))
        if (hit) c.add('warning', 'spoiler-action', `phases.${pi}.actions.${ai}.${field}`, `Action wording names the answer ("${hit}") before the student has chosen a diagnosis. Confirm this is intended.`)
      }
    }),
  )
  for (const d of s.diagnoses) {
    if (mentions(s.summary.title, d.label) || mentions(s.summary.complaint, d.label)) c.add('warning', 'spoiler-distractor', 'summary', `The summary names the diagnosis option "${d.label}".`)
  }
}

function checkImages(s: ScenarioDefinition, c: Collector) {
  const known = new Set([...s.phases.flatMap((p) => p.actions.map((a) => a.id)), ...s.planOptions.map((p) => p.id)])
  for (const [role, p] of [['patient.portrait', s.patient.portrait], ['clinician', s.clinician]] as const) {
    if (p.alt.trim().length < 5) c.add('error', 'image-alt', `${role}.alt`, 'Portrait alt text is missing or too short.')
    if (p.src && !/^(https:\/\/|\/)/.test(p.src)) c.add('error', 'image-src', `${role}.src`, 'Portrait src must be an https URL or a site-root path.')
  }
  const clinicalKinds = new Set(['ecg', 'xray', 'photo'])
  s.clinicalImages?.forEach((m, i) => {
    const path = `clinicalImages.${i}`
    if (!/^(https:\/\/|\/)/.test(m.src)) c.add('error', 'image-src', `${path}.src`, 'Image src must be an https URL or a site-root path.')
    if (clinicalKinds.has(m.kind) && m.decorative) c.add('error', 'image-alt', `${path}.decorative`, 'A clinical image carries findings, so it cannot be decorative.')
    if (m.decorative) {
      if (m.alt !== '') c.add('error', 'image-alt', `${path}.alt`, 'A decorative image must have empty alt text.')
    } else {
      if (m.alt.trim().length < 10) c.add('error', 'image-alt', `${path}.alt`, 'Alt text is missing or too short (10 characters minimum).')
      if (/^(image|picture|photo|figure)\b/i.test(m.alt.trim()) && m.alt.trim().split(/\s+/).length < 4) c.add('error', 'image-alt', `${path}.alt`, 'Alt text must describe the content, not name the file type.')
      if (clinicalKinds.has(m.kind) && !(m.longDescription && m.longDescription.trim().length >= 40)) {
        c.add('error', 'image-description', `${path}.longDescription`, 'A clinical image needs a longDescription of at least 40 characters for screen-reader and low-vision use.')
      }
    }
    if (!known.has(m.revealedBy)) c.add('error', 'image-reveal', `${path}.revealedBy`, `revealedBy "${m.revealedBy}" is not an action or plan option ID; images must be released by a student action.`)
    if (m.licenseSource.trim().length < 5) c.add('error', 'image-license', `${path}.licenseSource`, 'Record where the image came from and its license.')
  })
}

function checkReferences(s: ScenarioDefinition, now: string, c: Collector) {
  if (s.clinicalReferences.length === 0) c.add('error', 'reference-missing', 'clinicalReferences', 'At least one reference is required.')
  const seen = new Set<string>()
  s.clinicalReferences.forEach((r, i) => {
    const path = `clinicalReferences.${i}`
    if (!r.url.startsWith('https://')) c.add('error', 'reference-url', `${path}.url`, 'Reference URL must use https.')
    if (seen.has(r.url + r.title)) c.add('error', 'reference-duplicate', path, 'Duplicate reference.')
    seen.add(r.url + r.title)
    if (/faculty review|starting points|clinicsim/i.test(textOf(r.title, r.organization))) c.add('error', 'reference-placeholder', path, 'The title or organization is a placeholder. Cite the real publisher and title.')
    if (r.accessedAt > now) c.add('error', 'reference-date', `${path}.accessedAt`, 'accessedAt is in the future.')
    if (r.publishedOrUpdated && r.publishedOrUpdated > r.accessedAt) c.add('error', 'reference-date', `${path}.publishedOrUpdated`, 'The source date is after the access date.')
    if (!r.verified) c.add('warning', 'reference-unverified', path, `"${r.title}" is not verified against the source.`)
  })
  if (!s.clinicalReferences.some((r) => r.specificity === 'case-specific')) c.add('warning', 'reference-general', 'clinicalReferences', 'Only general references. Add a case-specific source and section.')
}

function checkTeachingText(s: ScenarioDefinition, c: Collector) {
  const lists: [string, string[]][] = [['teachingPoints', s.teachingPoints], ['idealPlan', s.idealPlan]]
  for (const [name, list] of lists) {
    if (list.length === 0) c.add('error', 'teaching-empty', name, `${name} must not be empty.`)
    list.forEach((t, i) => {
      if (t.length > MAX_TEACHING_TEXT) c.add('error', 'teaching-length', `${name}.${i}`, `Keep teaching text concise (${MAX_TEACHING_TEXT} characters maximum; this is ${t.length}).`)
      if (/https?:\/\//i.test(t)) c.add('error', 'teaching-url', `${name}.${i}`, 'Put sources in clinicalReferences, not in teaching text.')
    })
  }
}

function checkTaxonomy(s: ScenarioDefinition, vocab: TaxonomyVocabulary, c: Collector) {
  const t = s.taxonomy
  const check = (path: string, values: string[], allowed: { id: string }[]) => {
    const ids = new Set(allowed.map((a) => a.id))
    for (const v of values) if (!ids.has(v)) c.add('error', 'taxonomy-term', path, `"${v}" is not in content/taxonomy.json.`)
  }
  check('taxonomy.organSystems', t.organSystems, vocab.organSystems)
  check('taxonomy.panceTasks', t.panceTasks, vocab.panceTasks)
  check('taxonomy.careSetting', [t.careSetting], vocab.careSettings)
  check('taxonomy.ageGroup', [t.ageGroup], vocab.ageGroups)
  check('taxonomy.eorRotations', t.eorRotations, vocab.eorRotations)
  if (s.summary.urgent && t.acuity === 'routine') c.add('warning', 'taxonomy-acuity', 'taxonomy.acuity', 'summary.urgent is true but acuity is routine.')
}

function checkLifecycle(s: ScenarioDefinition, now: string, published: boolean, c: Collector) {
  const l = s.lifecycle
  const versions = l.changeLog.map((e) => e.version)
  if (new Set(versions).size !== versions.length) c.add('error', 'changelog', 'lifecycle.changeLog', 'Duplicate versions in the changelog.')
  const newest = [...versions].sort(cmpSemver).at(-1)
  if (newest !== l.contentVersion) c.add('error', 'changelog', 'lifecycle.changeLog', `The newest changelog version (${newest}) must equal contentVersion (${l.contentVersion}).`)
  if (l.status === 'retired' && published) c.add('error', 'retired-published', 'lifecycle.status', 'A retired case must have published: false in the manifest.')
  if (l.nextReviewDue < now) c.add('warning', 'review-overdue', 'lifecycle.nextReviewDue', `Review was due ${l.nextReviewDue}.`)

  const anchor = [...l.reviews.map((r) => r.reviewedAt), ...l.changeLog.map((e) => e.date)].sort().at(-1) as string
  if (daysBetween(anchor, l.nextReviewDue) > REVIEW_INTERVAL_DAYS) c.add('warning', 'review-interval', 'lifecycle.nextReviewDue', 'nextReviewDue is more than 12 months after the last review or change.')
  l.reviews.forEach((r, i) => {
    if (r.reviewedAt > now) c.add('error', 'review-date', `lifecycle.reviews.${i}.reviewedAt`, 'reviewedAt is in the future.')
    if (cmpSemver(r.contentVersion, l.contentVersion) > 0) c.add('error', 'review-version', `lifecycle.reviews.${i}.contentVersion`, 'A review cannot be of a version newer than the case.')
  })

  if (l.status === 'approved') {
    const qualified = l.reviews.some((r) => r.outcome === 'approved' && QUALIFIED_REVIEWER_ROLES.includes(r.reviewerRole) && r.contentVersion === l.contentVersion)
    if (!qualified) c.add('error', 'approval-guard', 'lifecycle.status', `Approved needs an "approved" review of version ${l.contentVersion} by ${QUALIFIED_REVIEWER_ROLES.join(', ')}. A PA-student review does not satisfy this.`)
    if (l.openItems.length) c.add('error', 'approval-guard', 'lifecycle.openItems', 'An approved case cannot have open review items.')
    if (s.criticalWaivers.length) c.add('error', 'approval-guard', 'criticalWaivers', 'An approved case cannot carry critical waivers.')
    if (s.taxonomy.provenance !== 'reviewed') c.add('error', 'approval-guard', 'taxonomy.provenance', 'Taxonomy must be marked reviewed before approval.')
    if (s.clinicalReferences.some((r) => !r.verified)) c.add('error', 'approval-guard', 'clinicalReferences', 'Every reference must be verified before approval.')
    if (!s.clinicalReferences.some((r) => r.specificity === 'case-specific')) c.add('error', 'approval-guard', 'clinicalReferences', 'Approval needs a case-specific reference.')
  } else if (l.status === 'clinical-review' && l.reviews.length === 0) {
    c.add('warning', 'review-status', 'lifecycle.status', 'Status is clinical-review but no review is recorded.')
  }
}

function checkFixtures(s: ScenarioDefinition, raw: unknown, c: Collector): ScenarioFixtureFile | null {
  if (raw === undefined) return null
  const parsed = scenarioFixtureFile.safeParse(raw)
  if (!parsed.success) {
    for (const i of parsed.error.issues) c.add('error', 'fixture-schema', ['fixtures', ...i.path.map(String)].join('.'), i.message)
    return null
  }
  const f = parsed.data
  if (f.scenarioId !== s.id) c.add('error', 'fixture-scenario', 'fixtures.scenarioId', `Fixture file is for "${f.scenarioId}".`)
  if (f.contentVersion !== s.lifecycle.contentVersion) c.add('error', 'fixture-version', 'fixtures.contentVersion', `Fixtures are for ${f.contentVersion} but the case is ${s.lifecycle.contentVersion}. Re-check and update them.`)
  const kinds = new Set(f.fixtures.map((x) => x.kind))
  for (const kind of ['happy-path', 'wrong-path', 'critical-safety-miss', 'partial-credit'] as const) {
    if (!kinds.has(kind)) c.add('error', 'fixture-missing', 'fixtures', `Missing a "${kind}" fixture.`)
  }
  const ids = new Set<string>()
  const owners = {
    history: new Set(s.phases.find((p) => p.id === 'history')?.actions.map((a) => a.id)),
    exam: new Set(s.phases.find((p) => p.id === 'exam')?.actions.map((a) => a.id)),
    diagnostics: new Set(s.phases.find((p) => p.id === 'diagnostics')?.actions.map((a) => a.id)),
    diagnosis: new Set(s.diagnoses.map((d) => d.id)),
    treatment: new Set(s.planOptions.map((p) => p.id)),
  }
  f.fixtures.forEach((fx, i) => {
    const path = `fixtures.${i}`
    if (ids.has(fx.id)) c.add('error', 'fixture-duplicate', path, `Duplicate fixture "${fx.id}".`)
    ids.add(fx.id)
    let ok = true
    for (const phase of phaseIds) {
      for (const id of fx.selections[phase]) {
        if (!owners[phase].has(id)) {
          c.add('error', 'fixture-ref', `${path}.selections.${phase}`, `"${id}" is not a ${phase} ID in this case.`)
          ok = false
        }
      }
    }
    if (!ok) return
    const r = gradeAttempt(s, attemptOf(s, fx.selections))
    const actual = { rawScore: r.rawScore, finalScore: r.finalScore, passed: r.passed, criticalSafetyError: r.criticalSafetyError, missedCount: r.missed.length, unsafeCount: r.unsafe.length }
    for (const [k, v] of Object.entries(actual)) {
      if ((fx.expect as Record<string, unknown>)[k] !== v) c.add('error', 'fixture-stale', `${path}.expect.${k}`, `Fixture "${fx.id}" expects ${k}=${String((fx.expect as Record<string, unknown>)[k])} but grading gives ${String(v)}.`)
    }
    const picked = fx.selections.diagnosis[0]
    if (fx.kind === 'happy-path' && !(actual.passed && !actual.criticalSafetyError && picked === s.correctPrimary)) c.add('error', 'fixture-kind', path, 'A happy-path fixture must pass, with the correct diagnosis and no critical error.')
    if (fx.kind === 'wrong-path' && !(picked && picked !== s.correctPrimary)) c.add('error', 'fixture-kind', path, 'A wrong-path fixture must choose a diagnosis other than the correct one.')
    if (fx.kind === 'partial-credit' && !(picked === s.correctPrimary && actual.missedCount >= 1 && !actual.criticalSafetyError)) c.add('error', 'fixture-kind', path, 'A partial-credit fixture must choose the correct diagnosis, miss at least one item and have no critical error.')
    if (fx.kind === 'critical-safety-miss' && s.criticalRules.length > 0 && !(actual.criticalSafetyError && actual.finalScore <= 59 && !actual.passed)) {
      c.add('error', 'fixture-kind', path, 'This case has critical rules, so a critical-safety-miss fixture must trigger one (capped at 59, not passed).')
    }
    if (fx.kind === 'critical-safety-miss' && s.criticalRules.length === 0 && actual.unsafeCount < 1) c.add('error', 'fixture-kind', path, 'Without critical rules, a critical-safety-miss fixture must at least select a flagged unsafe option.')
  })
  return f
}

export function validatePackage(raw: RawPackage, options: ValidateOptions = {}): ValidationResult {
  const issues: Issue[] = [...raw.loadIssues]
  const now = (options.now ?? new Date()).toISOString().slice(0, 10)
  const gradingVersion = options.gradingVersion ?? GRADING_VERSION
  const pkgC = collectorFor(issues)

  const manifest = manifestSchema.safeParse(raw.manifest)
  if (raw.manifest !== undefined && !manifest.success) issues.push(...zodIssues('manifest', manifest.error))
  const lock = lockSchema.safeParse(raw.lock)
  if (raw.lock !== undefined && !lock.success) issues.push(...zodIssues('lock', lock.error))
  const vocab = taxonomyVocabularySchema.safeParse(raw.taxonomy)
  if (raw.taxonomy !== undefined && !vocab.success) issues.push(...zodIssues('taxonomy', vocab.error))

  const scenarios: ScenarioDefinition[] = []
  const fixtures: Record<string, ScenarioFixtureFile> = {}
  let remediation: ValidatedRemediation = { knowledge: null, remediation: {} }

  if (manifest.success) {
    const m = manifest.data
    if (m.gradingVersion !== gradingVersion) pkgC.add('error', 'grading-version', 'manifest.gradingVersion', `Manifest targets ${m.gradingVersion} but the grader is ${gradingVersion}. Re-check fixtures and update the manifest.`)
    const ids = m.scenarios.map((e) => e.id)
    for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) pkgC.add('error', 'duplicate-scenario-id', 'manifest.scenarios', `Scenario ID "${id}" appears more than once.`)
    const listedFiles = new Set(m.scenarios.map((e) => e.file.replace(/^scenarios\//, '')))
    for (const f of raw.scenarioFilesOnDisk) {
      if (!listedFiles.has(f)) pkgC.add('error', 'orphan-file', `scenarios/${f}`, `${f} is not listed in the manifest. List it or delete it.`)
    }

    for (const entry of m.scenarios) {
      const c = collectorFor(issues, entry.id)
      const input = raw.scenarios[entry.id]
      if (input === undefined) continue
      const parsed = safeParseScenario(input)
      if (!parsed.success) {
        issues.push(...zodIssues('scenario', parsed.error, entry.id))
        continue
      }
      const s = parsed.data as ScenarioDefinition
      if (s.id !== entry.id) c.add('error', 'id-mismatch', 'id', `File declares id "${s.id}" but the manifest lists "${entry.id}".`)
      if (s.lifecycle.contentVersion !== entry.contentVersion) c.add('error', 'manifest-mismatch', 'manifest.contentVersion', `Manifest says ${entry.contentVersion} but the case is ${s.lifecycle.contentVersion}.`)
      if (s.lifecycle.status !== entry.status) c.add('error', 'manifest-mismatch', 'manifest.status', `Manifest says ${entry.status} but the case is ${s.lifecycle.status}.`)

      indexIds(s, c)
      checkPhases(s, c)
      checkRubric(s, c)
      checkRules(s, c)
      checkSpoilers(s, c)
      checkImages(s, c)
      checkReferences(s, now, c)
      checkTeachingText(s, c)
      if (vocab.success) checkTaxonomy(s, vocab.data, c)
      checkLifecycle(s, now, entry.published, c)
      const hasStructuralErrors = issues.some((i) => i.scenarioId === entry.id && i.severity === 'error')
      if (!hasStructuralErrors) {
        checkHappyPath(s, c)
        const f = checkFixtures(s, raw.fixtures[entry.id], c)
        if (f) fixtures[entry.id] = f
        else if (raw.fixtures[entry.id] === undefined) c.add('error', 'fixture-missing', 'fixtures', 'Fixture file is missing.')
      }
      scenarios.push(s)
    }

    if (lock.success) {
      const releases = lock.data.releases
      for (const s of scenarios) {
        const c = collectorFor(issues, s.id)
        const mine = releases.filter((r) => r.id === s.id)
        const fp = contentFingerprint(s)
        const exact = mine.find((r) => r.contentVersion === s.lifecycle.contentVersion)
        if (exact && exact.fingerprint !== fp) {
          c.add('error', 'lock-mismatch', 'lifecycle.contentVersion', `Content changed since ${exact.contentVersion} was locked. Bump lifecycle.contentVersion (and the changelog), then run npm run content:lock.`)
        }
        if (!exact) c.add(options.strict ? 'error' : 'warning', 'lock-missing', 'lifecycle.contentVersion', `Version ${s.lifecycle.contentVersion} is not in content/lock.json. Run npm run content:lock once it is final.`)
        const newerLocked = mine.find((r) => cmpSemver(r.contentVersion, s.lifecycle.contentVersion) > 0)
        if (newerLocked) c.add('error', 'lock-regression', 'lifecycle.contentVersion', `Version ${newerLocked.contentVersion} is already locked; versions cannot go backwards.`)
      }
      for (const r of releases) {
        if (!m.scenarios.some((e) => e.id === r.id)) pkgC.add('error', 'lock-orphan', 'lock.releases', `"${r.id}" has locked releases but is not in the manifest. Retire cases instead of deleting them.`)
      }
    }
    remediation = validateRemediation(raw, scenarios, vocab.success ? vocab.data : null, lock.success ? lock.data : null, options, issues)
    if (manifest.data.scenarios.some((e) => !e.published && e.status !== 'retired')) {
      pkgC.add('warning', 'unpublished', 'manifest.scenarios', 'A case that is not retired is unpublished and invisible to learners.')
    }
  }

  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  return {
    issues,
    errors,
    warnings,
    package: errors.length === 0 && manifest.success && lock.success && vocab.success ? { manifest: manifest.data, lock: lock.data, taxonomy: vocab.data, scenarios, fixtures, ...remediation } : null,
  }
}

export function formatIssues(issues: Issue[]): string {
  return issues
    .map((i) => `${i.severity === 'error' ? 'ERROR  ' : 'warning'} [${i.code}] ${i.scenarioId ? `${i.scenarioId}: ` : ''}${i.path}: ${i.message}`)
    .join('\n')
}
