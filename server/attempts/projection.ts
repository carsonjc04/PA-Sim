import type {
  AttemptSummary,
  PublicAttempt,
  PublicDebrief,
  PublicEvent,
  PublicScenario,
} from '../../src/api/contracts'
import { canonicalTags } from '../../src/domain/study/taxonomy'
import type { GradingResult, ScenarioDefinition } from '../../src/domain/types'
import { contentPackage } from '../content/scenarios'
import { buildReasoningDebrief } from './debrief'
import type { AttemptRow, EventRow, HistoryRow, ResultRow } from './repository'

// Every browser payload is built by allowlist, so a field added to ScenarioDefinition cannot leak by being forgotten.

export function toPublicScenario(s: ScenarioDefinition): PublicScenario {
  return {
    id: s.id,
    schemaVersion: s.schemaVersion,
    summary: { ...s.summary },
    patient: { name: s.patient.name, demographics: s.patient.demographics, portrait: { ...s.patient.portrait } },
    clinician: { ...s.clinician },
    opening: s.opening,
    initialInfo: [...s.initialInfo],
    phases: s.phases.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      // `response` is withheld; it is released only by recording the action.
      actions: p.actions.map((a) => ({ id: a.id, label: a.label, paText: a.paText, kind: a.kind })),
    })),
    diagnoses: s.diagnoses.map((d) => ({ id: d.id, label: d.label })),
    planOptions: s.planOptions.map((p) => ({ id: p.id, label: p.label, group: p.group })),
    reviewStatus: s.lifecycle.status === 'approved' ? 'clinician-reviewed' : 'requires-clinician-review',
    // Provenance only: verification state, notes and review records stay server-side.
    clinicalReferences: s.clinicalReferences.map((r) => ({
      title: r.title,
      organization: r.organization,
      url: r.url,
      ...(r.publishedOrUpdated ? { publishedOrUpdated: r.publishedOrUpdated } : {}),
    })),
    tags: publicTags(s),
  }
}

/** Canonical filter tags. Deprecated IDs resolve through the current vocabulary; topic tags, provenance and blueprint reviews stay server-side. */
function publicTags(s: ScenarioDefinition): PublicScenario['tags'] {
  const t = canonicalTags(s.taxonomy, contentPackage().taxonomy)
  return { organSystems: t.organSystems, panceTasks: t.panceTasks, eorRotations: t.eorRotations, suitability: { ...s.taxonomy.suitability, modes: [...s.taxonomy.suitability.modes] } }
}

function toPublicEvent(e: EventRow): PublicEvent | null {
  if (e.type !== 'action' || !e.actionId) return null
  return {
    seq: e.seq,
    phase: e.phase,
    actionId: e.actionId,
    kind: e.kind ?? 'action',
    confirmed: e.confirmed,
    revealed: e.revealed,
    source: e.source === 'voice' ? 'voice' : 'guided',
    at: e.createdAt,
  }
}

export function toPublicDebrief(scenario: ScenarioDefinition, stored: ResultRow, events: EventRow[] = [], startedAt: string = stored.createdAt): PublicDebrief {
  const r = stored.result as GradingResult
  return {
    gradingVersionId: stored.gradingVersionId,
    contentVersionId: stored.contentVersionId,
    gradedAt: stored.createdAt,
    categoryScores: { ...r.categoryScores },
    rawScore: r.rawScore,
    finalScore: r.finalScore,
    passed: r.passed,
    criticalSafetyError: r.criticalSafetyError,
    criticalMessages: [...r.criticalMessages],
    strengths: [...r.strengths],
    missed: [...r.missed],
    unnecessary: [...r.unnecessary],
    unsafe: [...r.unsafe],
    correctDiagnosisLabel: scenario.diagnoses.find((d) => d.id === scenario.correctPrimary)?.label ?? '',
    diagnosisReasoning: r.diagnosisReasoning,
    idealPlan: [...r.idealPlan],
    reasoning: buildReasoningDebrief(scenario, events, startedAt),
  }
}

export function toPublicAttempt(
  attempt: AttemptRow,
  scenario: ScenarioDefinition,
  events: EventRow[],
  result: ResultRow | null,
): PublicAttempt {
  return {
    id: attempt.id,
    scenarioId: attempt.scenarioId,
    contentVersionId: attempt.contentVersionId,
    status: attempt.status,
    currentPhase: attempt.currentPhase,
    lockedPhases: [...attempt.lockedPhases],
    scenario: toPublicScenario(scenario),
    events: events.map(toPublicEvent).filter((e): e is PublicEvent => e !== null),
    createdAt: attempt.createdAt,
    submittedAt: attempt.submittedAt,
    debrief: attempt.status === 'submitted' && result ? toPublicDebrief(scenario, result, events, attempt.createdAt) : null,
  }
}

export function toAttemptSummary(row: HistoryRow): AttemptSummary {
  return {
    id: row.id,
    scenarioId: row.scenarioId,
    scenarioTitle: row.scenarioTitle,
    status: row.status,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
    finalScore: row.finalScore,
    passed: row.passed,
  }
}
