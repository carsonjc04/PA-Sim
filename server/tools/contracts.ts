import { z } from 'zod'
import type { PhaseId } from '../../src/domain/types'

type EventKind = 'history' | 'exam' | 'test' | 'communication' | 'diagnosis' | 'treatment' | 'disposition' | 'follow-up'

/**
 * Tool arguments carry IDs only. Scores, findings and display text are never
 * accepted from the model — the server resolves those from the locked scenario.
 */
const ids = z.array(z.string().min(1)).min(1).max(12)

export const toolContracts = {
  record_history_topics: {
    phase: 'history' as PhaseId,
    kind: 'history' as EventKind,
    schema: z.object({ actionIds: ids }),
  },
  request_physical_exam: {
    phase: 'exam' as PhaseId,
    kind: 'exam' as EventKind,
    schema: z.object({ actionIds: ids }),
  },
  order_diagnostic_test: {
    phase: 'diagnostics' as PhaseId,
    kind: 'test' as EventKind,
    schema: z.object({ actionIds: ids }),
  },
  record_communication_behavior: {
    phase: null,
    kind: 'communication' as EventKind,
    schema: z.object({ actionIds: ids }),
  },
  propose_diagnosis: {
    phase: 'diagnosis' as PhaseId,
    kind: 'diagnosis' as EventKind,
    schema: z.object({ actionIds: ids, confirmed: z.boolean().default(false) }),
  },
  propose_treatment_plan: {
    phase: 'treatment' as PhaseId,
    kind: 'treatment' as EventKind,
    schema: z.object({ actionIds: ids, confirmed: z.boolean().default(false) }),
  },
  record_disposition: {
    phase: 'treatment' as PhaseId,
    kind: 'disposition' as EventKind,
    schema: z.object({ actionIds: ids, confirmed: z.boolean().default(false) }),
  },
  record_follow_up: {
    phase: 'treatment' as PhaseId,
    kind: 'follow-up' as EventKind,
    schema: z.object({ actionIds: ids, confirmed: z.boolean().default(false) }),
  },
} as const

export type ToolName = keyof typeof toolContracts

/** Which planOption groups each plan-facing tool may select from. */
export const planGroupsByTool: Partial<Record<ToolName, string[]>> = {
  propose_treatment_plan: ['treatment', 'counseling'],
  record_disposition: ['disposition'],
  record_follow_up: ['follow-up', 'return'],
}

/** Tools whose selections are graded only after the student confirms them. */
export const requiresConfirmation = new Set<ToolName>([
  'propose_diagnosis',
  'propose_treatment_plan',
  'record_disposition',
  'record_follow_up',
])

export const toolNames = Object.keys(toolContracts) as ToolName[]

export function isToolName(value: string): value is ToolName {
  return value in toolContracts
}
