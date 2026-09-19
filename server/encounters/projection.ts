import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'
import type { EncounterRecord } from './model'

/**
 * Built by explicit allowlist rather than by deleting sensitive keys, so a
 * field added to ScenarioDefinition later cannot leak through this boundary
 * by being forgotten.
 */
export interface PublicAction {
  id: string
  label: string
  paText: string
  kind?: string
}

export interface PublicScenario {
  id: string
  schemaVersion: string
  summary: ScenarioDefinition['summary']
  patient: ScenarioDefinition['patient']
  clinician: ScenarioDefinition['clinician']
  opening: string
  initialInfo: string[]
  phases: { id: PhaseId; label: string; description: string; actions: PublicAction[] }[]
  diagnoses: { id: string; label: string }[]
  planOptions: { id: string; label: string; group: string }[]
  reviewStatus: string
  clinicalReferences: ScenarioDefinition['clinicalReferences']
}

export function toPublicScenario(s: ScenarioDefinition): PublicScenario {
  return {
    id: s.id,
    schemaVersion: s.schemaVersion,
    summary: s.summary,
    patient: s.patient,
    clinician: s.clinician,
    opening: s.opening,
    initialInfo: s.initialInfo,
    phases: s.phases.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      // `response` is withheld here; it is released only by executing the action.
      actions: p.actions.map((a) => ({ id: a.id, label: a.label, paText: a.paText, kind: a.kind })),
    })),
    diagnoses: s.diagnoses.map((d) => ({ id: d.id, label: d.label })),
    planOptions: s.planOptions.map((p) => ({ id: p.id, label: p.label, group: p.group })),
    reviewStatus: s.reviewStatus,
    clinicalReferences: s.clinicalReferences,
  }
}

export interface PublicEncounter {
  id: string
  mode: EncounterRecord['mode']
  scenario: PublicScenario
  currentPhase: PhaseId
  lockedPhases: PhaseId[]
  /** Neutral capture log. Carries no correctness signal. */
  events: { id: string; phase: PhaseId; kind: string; at: string; revealed?: string; confirmed?: boolean }[]
  submitted: boolean
  createdAt: string
  live?: { sessionId?: string; startedAt?: string; durationSeconds?: number }
}

export function toPublicEncounter(record: EncounterRecord): PublicEncounter {
  return {
    id: record.id,
    mode: record.mode,
    scenario: toPublicScenario(record.hidden),
    currentPhase: record.currentPhase,
    lockedPhases: record.lockedPhases,
    events: record.events.map((e) => ({
      id: e.id,
      phase: e.phase,
      kind: e.kind,
      at: e.at,
      revealed: e.revealed,
      confirmed: e.confirmed,
    })),
    submitted: record.submitted,
    createdAt: record.createdAt,
    live: record.liveSessionId
      ? {
          sessionId: record.liveSessionId,
          startedAt: record.liveStartedAt,
          durationSeconds: record.liveDurationSeconds,
        }
      : undefined,
  }
}
