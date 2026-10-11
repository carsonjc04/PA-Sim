import { z } from 'zod'
import { ID_PATTERN, SEMVER_PATTERN, isIsoDate } from '../schema'

const id = z.string().regex(ID_PATTERN, 'IDs are lowercase kebab-case')
const text = z.string().trim().min(1)
const isoDate = z.string().refine(isIsoDate, 'Expected a calendar date as YYYY-MM-DD')
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase sha256 hex digest')
const pct = z.number().min(0).max(100)

/** One way an item can fall in a blueprint category: every listed field must match (each field matches if the item has any listed value). */
const crosswalkClause = z
  .strictObject({
    organSystems: z.array(id).min(1).optional(),
    panceTasks: z.array(id).min(1).optional(),
    topicTags: z.array(id).min(1).optional(),
    careSettings: z.array(id).min(1).optional(),
    ageGroups: z.array(id).min(1).optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'A crosswalk clause needs at least one field')

/** An item falls in the category when any clause matches. */
const crosswalk = z.strictObject({ anyOf: z.array(crosswalkClause).min(1) })

export const blueprintSchema = z.strictObject({
  id,
  issuer: z.enum(['NCCPA', 'PAEA']),
  exam: z.enum(['pance', 'eor']),
  rotation: id.nullable(),
  title: text,
  versionLabel: text,
  /** First day the version applies; null when the source does not state it. */
  effectiveFrom: isoDate.nullable(),
  /** Last day the version may be administered; null when open-ended. */
  effectiveUntil: isoDate.nullable(),
  /** Exact source wording behind the dates, and how unstated dates were handled. */
  dateNotes: text,
  publishedAt: isoDate.nullable(),
  supersedes: z.array(id),
  supersededBy: id.nullable(),
  source: z.strictObject({
    documentUrl: z.url(),
    landingPage: z.url(),
    retrievedAt: isoDate,
    sha256,
    /** Set when the official URL could not be fetched directly (for example an archive capture of it). */
    retrievedVia: z.url().nullable(),
    retrievalNote: text.nullable(),
  }),
  examStructure: z.strictObject({ items: z.number().int().positive().nullable(), format: text }),
  contentCategories: z.array(z.strictObject({ id, label: text, weightPct: pct, crosswalk })).min(1),
  taskCategories: z.array(z.strictObject({ id, label: text, weightPct: pct, canonicalTask: id })).min(1),
  /** Official item counts per content x task cell (PAEA). Absent when the issuer publishes marginals only (NCCPA). */
  cells: z.array(z.strictObject({ content: id, task: id, items: z.number().int().nonnegative() })).optional(),
  /** Content/task pairs that are the only allowed pairing for that content category (PANCE Professional Practice). */
  taskCodingExclusions: z.array(z.strictObject({ content: id, task: id })).optional(),
  secondaryTargets: z
    .array(
      z.strictObject({
        id,
        label: text,
        /** True when the values split the whole exam and must total 100. */
        partition: z.boolean(),
        values: z.array(z.strictObject({ id, label: text, minPct: pct, maxPct: pct, crosswalk })).min(1),
      }),
    )
    .optional(),
  transcription: z.strictObject({
    method: text,
    transcribedAt: isoDate,
    transcribedBy: text,
    /** Reviewer role who re-checked every number against the source; null until then. */
    verifiedBy: text.nullable(),
    verifiedAt: isoDate.nullable(),
  }),
  notes: z.array(text),
})
export type Blueprint = z.infer<typeof blueprintSchema>
export type Crosswalk = z.infer<typeof crosswalk>
export type CrosswalkClause = z.infer<typeof crosswalkClause>

/**
 * A differential sprint is assembled entirely from an existing case: the stem comes from the case summary,
 * findings are that case's own action responses and the options are its own diagnosis options. Nothing
 * clinical is authored here, so a sprint can never assert a fact the case does not.
 */
export const sprintSchema = z.strictObject({
  id,
  sourceScenarioId: id,
  /** The case version the sprint was checked against; a newer case version invalidates the sprint until re-checked. */
  sourceContentVersion: z.string().regex(SEMVER_PATTERN),
  findingActionIds: z.array(id).min(2).max(6),
  optionIds: z.array(id).min(3).max(5),
  status: z.enum(['draft', 'retired']),
  changeLog: z.array(z.strictObject({ date: isoDate, summary: text })).min(1),
})
export type SprintDefinition = z.infer<typeof sprintSchema>

export const taxonomyHistorySchema = z.strictObject({
  note: text,
  axes: z.strictObject({
    organSystems: z.array(id),
    panceTasks: z.array(id),
    topicTags: z.array(id),
    careSettings: z.array(id),
    ageGroups: z.array(id),
    eorRotations: z.array(id),
  }),
})
export type TaxonomyHistory = z.infer<typeof taxonomyHistorySchema>
