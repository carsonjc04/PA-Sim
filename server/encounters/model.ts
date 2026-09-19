import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'

export type EncounterMode = 'guided' | 'voice-handcrafted' | 'voice-generated'

export interface EncounterEvent {
  /** Stable action / diagnosis / plan ID from the locked scenario. */
  id: string
  phase: PhaseId
  kind: 'history' | 'exam' | 'test' | 'communication' | 'diagnosis' | 'treatment' | 'disposition' | 'follow-up'
  at: string
  /** Text returned to the student. Never includes scoring metadata. */
  revealed?: string
  /** True once the student explicitly confirmed a safety-critical selection. */
  confirmed?: boolean
}

export interface EncounterRecord {
  id: string
  studentId: string
  mode: EncounterMode
  scenarioId: string
  /** Full answer key. Never serialized to the browser before submission. */
  hidden: ScenarioDefinition
  schemaVersion: string
  promptVersion: string
  liveModel: string
  reasoningModel: string
  generationSeed?: string
  currentPhase: PhaseId
  lockedPhases: PhaseId[]
  events: EncounterEvent[]
  createdAt: string
  submittedAt?: string
  submitted: boolean
  liveSessionId?: string
  liveStartedAt?: string
  liveEndedAt?: string
  liveDurationSeconds?: number
}

/** Selections grouped by phase, derived from the event log. */
export function selectionsByPhase(record: EncounterRecord): Record<PhaseId, string[]> {
  const out: Record<PhaseId, string[]> = {
    history: [],
    exam: [],
    diagnostics: [],
    diagnosis: [],
    treatment: [],
  }
  for (const event of record.events) {
    if (!out[event.phase].includes(event.id)) out[event.phase].push(event.id)
  }
  return out
}
