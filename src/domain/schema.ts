import { z } from 'zod'
import type { ScenarioDefinition } from './types'

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const id = z.string().regex(ID_PATTERN, 'IDs are lowercase kebab-case')
const text = z.string().trim().min(1)
const isoDate = z.string().refine(isIsoDate, 'Expected a calendar date as YYYY-MM-DD')
const semver = z.string().regex(SEMVER_PATTERN, 'Expected a semantic version such as 1.0.0')

export const phaseIds = ['history', 'exam', 'diagnostics', 'diagnosis', 'treatment'] as const
export const categories = ['history', 'exam', 'diagnostics', 'diagnosis', 'treatment', 'communication'] as const
export const planGroups = ['treatment', 'disposition', 'counseling', 'return', 'follow-up'] as const

const effect = z.strictObject({ category: z.enum(categories), points: z.number().int() })
const portrait = z.strictObject({ src: z.string().min(1).optional(), alt: z.string(), fallback: z.string() })

const action = z.strictObject({
  id,
  label: text,
  paText: text,
  response: text,
  kind: z.enum(['question', 'finding', 'test', 'choice']).optional(),
  effects: z.array(effect).optional(),
  rule: z
    .strictObject({
      requires: z.array(id).optional(),
      excludes: z.array(id).optional(),
      unlocks: z.array(id).optional(),
      hides: z.array(id).optional(),
    })
    .optional(),
  unsafeReason: text.optional(),
})

const reviewerRole = z.enum(['PA-C', 'MD', 'DO', 'NP', 'PharmD', 'PA-student'])

const review = z.strictObject({
  reviewerRole,
  reviewedAt: isoDate,
  contentVersion: semver,
  scope: text,
  outcome: z.enum(['approved', 'changes-requested', 'comments']),
})

const lifecycle = z.strictObject({
  status: z.enum(['draft', 'clinical-review', 'approved', 'retired']),
  contentVersion: semver,
  reviews: z.array(review),
  nextReviewDue: isoDate,
  openItems: z.array(text),
  changeLog: z.array(z.strictObject({ version: semver, date: isoDate, summary: text })).min(1),
})

const reference = z.strictObject({
  title: text,
  organization: text,
  url: z.url(),
  accessedAt: isoDate,
  publishedOrUpdated: isoDate.optional(),
  specificity: z.enum(['case-specific', 'general']),
  verified: z.boolean(),
  notes: text.optional(),
})

const taxonomy = z.strictObject({
  provenance: z.enum(['author-proposed-unreviewed', 'reviewed']),
  organSystems: z.array(text).min(1),
  panceTasks: z.array(text).min(1),
  careSetting: text,
  acuity: z.enum(['routine', 'urgent', 'emergent']),
  ageGroup: text,
  eorRotations: z.array(text).min(1),
})

const clinicalImage = z.strictObject({
  id,
  src: text,
  kind: z.enum(['ecg', 'xray', 'photo', 'diagram', 'other']),
  alt: z.string(),
  longDescription: z.string().optional(),
  decorative: z.boolean(),
  revealedBy: id,
  licenseSource: z.string(),
})

const scenario = z.strictObject({
  schemaVersion: z.literal('2.0'),
  id,
  summary: z.strictObject({
    title: text,
    complaint: text,
    age: text,
    pronouns: text,
    difficulty: z.enum(['Foundational', 'Intermediate', 'Urgent']),
    duration: text,
    urgent: z.boolean(),
    setting: text,
  }),
  patient: z.strictObject({ name: text, demographics: text, portrait }),
  clinician: portrait,
  opening: text,
  initialInfo: z.array(text),
  phases: z.array(z.strictObject({ id: z.enum(phaseIds), label: text, description: text, actions: z.array(action) })),
  omissions: z.array(
    z.strictObject({ id, phase: z.enum(phaseIds), label: text, when: z.array(id).min(1), effects: z.array(effect), feedback: text }),
  ),
  diagnoses: z.array(z.strictObject({ id, label: text, primary: z.boolean().optional(), effects: z.array(effect), reasoning: text.optional() })),
  planOptions: z.array(
    z.strictObject({ id, label: text, group: z.enum(planGroups), effects: z.array(effect), unsafe: z.boolean().optional(), unsafeReason: text.optional() }),
  ),
  correctPrimary: id,
  criticalRules: z.array(z.strictObject({ id, when: z.array(id).min(1), explanation: text })),
  criticalWaivers: z.array(z.strictObject({ optionId: id, reason: text })),
  spoilerTerms: z.array(text),
  teachingPoints: z.array(text),
  idealPlan: z.array(text),
  clinicalReferences: z.array(reference),
  clinicalImages: z.array(clinicalImage).optional(),
  taxonomy,
  lifecycle,
})

export const scenarioFixtureFile = z.strictObject({
  scenarioId: id,
  contentVersion: semver,
  fixtures: z.array(
    z.strictObject({
      id,
      kind: z.enum(['happy-path', 'wrong-path', 'critical-safety-miss', 'partial-credit']),
      description: text,
      selections: z.strictObject({
        history: z.array(id),
        exam: z.array(id),
        diagnostics: z.array(id),
        diagnosis: z.array(id),
        treatment: z.array(id),
      }),
      expect: z.strictObject({
        rawScore: z.number().int(),
        finalScore: z.number().int(),
        passed: z.boolean(),
        criticalSafetyError: z.boolean(),
        missedCount: z.number().int().nonnegative(),
        unsafeCount: z.number().int().nonnegative(),
      }),
    }),
  ),
})

export type ScenarioFixtureFile = z.infer<typeof scenarioFixtureFile>

export const manifestSchema = z.strictObject({
  manifestVersion: semver,
  schemaVersion: z.literal('2.0'),
  gradingVersion: text,
  scenarios: z.array(z.strictObject({ id, file: text, contentVersion: semver, status: lifecycle.shape.status, published: z.boolean() })).min(1),
})
export type ContentManifest = z.infer<typeof manifestSchema>

export const lockSchema = z.strictObject({
  lockVersion: z.literal(1),
  releases: z.array(z.strictObject({ id, contentVersion: semver, fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })),
  /** Locked remediation sidecars (content/remediation/<scenarioId>.json), versioned independently of the case. */
  remediation: z.array(z.strictObject({ scenarioId: id, remediationVersion: semver, fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })).optional(),
})
export type ContentLock = z.infer<typeof lockSchema>

export const taxonomyVocabularySchema = z.strictObject({
  provenance: text,
  organSystems: z.array(z.strictObject({ id, label: text })),
  panceTasks: z.array(z.strictObject({ id, label: text })),
  careSettings: z.array(z.strictObject({ id, label: text })),
  ageGroups: z.array(z.strictObject({ id, label: text })),
  eorRotations: z.array(z.strictObject({ id, label: text })),
})
export type TaxonomyVocabulary = z.infer<typeof taxonomyVocabularySchema>

export function validateScenario(input: unknown): ScenarioDefinition {
  return scenario.parse(input) as ScenarioDefinition
}
export function validateScenarios(input: unknown[]): ScenarioDefinition[] {
  return input.map(validateScenario)
}
export function safeParseScenario(input: unknown) {
  return scenario.safeParse(input)
}
