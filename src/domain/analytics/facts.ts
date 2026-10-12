// Turns stored rows into normalized facts. Pure: the server loads the rows, this decides what they mean.
import type { ErrorType, KnowledgeLibrary, MissKind, ScenarioRemediation } from '../remediation/types'
import type { ItemTags } from '../study/taxonomy'
import type { PhaseId, ScenarioDefinition } from '../types'
import type { AttemptFact, DiagnosisEventFact } from './types'

export interface StoredAttempt {
  id: string
  scenarioId: string
  contentVersionId: string
  createdAt: string
  submittedAt: string
  criticalSafetyError: boolean
  /** remediation_derivations.remediation_version; null when the case had no authored remediation then. */
  derivationVersion: string | null
}

export interface StoredDiagnosisEvent {
  id: string
  attemptId: string
  seq: number
  actionId: string
  confirmed: boolean
  retractedAt: string | null
  detail: unknown
  createdAt: string
}

export interface StoredEvidence {
  id: string
  attemptId: string
  rubricItemId: string
  kind: MissKind
  errorType: ErrorType
  phase: PhaseId
  label: string
  kcIds: string[]
  createdAt: string
}

function confidenceHistory(detail: unknown, at: string): DiagnosisEventFact['confidenceHistory'] {
  const d = (detail ?? {}) as { confidence?: unknown; confidenceHistory?: unknown }
  const valid = (c: unknown): c is 'sure' | 'unsure' => c === 'sure' || c === 'unsure'
  if (Array.isArray(d.confidenceHistory)) {
    return d.confidenceHistory.filter((h): h is { confidence: 'sure' | 'unsure'; at: string } => valid(h?.confidence) && typeof h?.at === 'string')
  }
  // Rows written before confidence history was kept hold only the latest value.
  return valid(d.confidence) ? [{ confidence: d.confidence, at }] : []
}

/**
 * Objectives an attempt could show evidence for, from the remediation mapping it was derived with.
 * Null when the stored derivation used a mapping version that is no longer current: the old mapping is
 * not kept, so which objectives that attempt could have shown is unknown.
 */
export function objectiveIdsFor(derivationVersion: string | null, remediation: ScenarioRemediation | undefined, library: KnowledgeLibrary | null): string[] | null {
  if (!remediation || !library) return derivationVersion === null ? [] : null
  if (derivationVersion !== remediation.remediationVersion) return null
  const kcs = new Set(Object.values(remediation.mappings).flatMap((m) => m.kcIds))
  return [...new Set(library.components.filter((c) => kcs.has(c.id)).flatMap((c) => c.objectiveIds))].sort()
}

export function attemptFact(input: {
  attempt: StoredAttempt
  /** The pinned content version that was played. */
  scenario: ScenarioDefinition
  tags: ItemTags
  diagnosisEvents: readonly StoredDiagnosisEvent[]
  evidence: readonly StoredEvidence[]
  remediation: ScenarioRemediation | undefined
  library: KnowledgeLibrary | null
}): AttemptFact {
  const { attempt } = input
  return {
    attemptId: attempt.id,
    scenarioId: attempt.scenarioId,
    scenarioTitle: input.scenario.summary.title,
    contentVersionId: attempt.contentVersionId,
    startedAt: attempt.createdAt,
    submittedAt: attempt.submittedAt,
    tags: input.tags,
    criticalSafetyError: attempt.criticalSafetyError,
    misses: input.evidence
      .filter((e) => e.attemptId === attempt.id)
      .map((e) => ({ evidenceId: e.id, attemptId: e.attemptId, rubricItemId: e.rubricItemId, kind: e.kind, errorType: e.errorType, phase: e.phase, label: e.label, kcIds: [...e.kcIds].sort(), at: e.createdAt }))
      .sort((a, b) => a.rubricItemId.localeCompare(b.rubricItemId)),
    diagnosisEvents: input.diagnosisEvents
      .filter((e) => e.attemptId === attempt.id)
      .map((e) => ({ eventId: e.id, seq: e.seq, actionId: e.actionId, confirmed: e.confirmed, retracted: e.retractedAt !== null, at: e.createdAt, confidenceHistory: confidenceHistory(e.detail, e.createdAt) }))
      .sort((a, b) => a.seq - b.seq),
    objectiveIds: objectiveIdsFor(attempt.derivationVersion, input.remediation, input.library),
  }
}
