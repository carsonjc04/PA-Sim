import { z } from 'zod'
import { ID_PATTERN, SEMVER_PATTERN } from '../schema'
import { errorTypes, promptTypes } from './types'

const id = z.string().regex(ID_PATTERN, 'IDs are lowercase kebab-case')
const text = z.string().trim().min(1)
const semver = z.string().regex(SEMVER_PATTERN, 'Expected a semantic version such as 1.0.0')
const provenance = z.enum(['author-proposed-unreviewed', 'reviewed'])

export const knowledgeLibrarySchema = z.strictObject({
  libraryVersion: semver,
  provenance,
  objectives: z.array(z.strictObject({ id, statement: text, panceTasks: z.array(id).min(1) })).min(1),
  components: z
    .array(z.strictObject({ id, label: text, objectiveIds: z.array(id).min(1), panceTasks: z.array(id).min(1), organSystems: z.array(id) }))
    .min(1),
})

export const scenarioRemediationSchema = z.strictObject({
  scenarioId: id,
  remediationVersion: semver,
  provenance,
  mappings: z.record(id, z.strictObject({ kcIds: z.array(id).min(1), errorType: z.enum(errorTypes).optional() })),
  prompts: z
    .array(
      z.strictObject({
        id,
        kcId: id,
        type: z.enum(promptTypes),
        front: text,
        choices: z.array(text).min(2).max(5).optional(),
        answer: text,
        explanation: text,
      }),
    )
    .min(1),
})
