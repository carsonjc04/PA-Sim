import { classifyMiss, deriveMisses } from '../../src/domain/remediation/misses'
import type { Confidence, DueReason, Miss } from '../../src/domain/remediation/types'
import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'
import type { EventRow } from '../attempts/repository'
import { contentPackage } from '../content/scenarios'
import type { Queryable } from '../db/pool'
import * as repo from './repository'
import { getScheduler } from './scheduler'

/** Confidence recorded with the live, confirmed primary diagnosis; null when the student skipped it. */
export function confidenceOf(events: EventRow[]): Confidence | null {
  const dx = events.filter((e) => e.type === 'action' && e.phase === 'diagnosis' && e.confirmed).at(-1)
  const value = (dx?.detail as { confidence?: unknown } | null)?.confidence
  return value === 'sure' || value === 'unsure' ? value : null
}

export interface DerivationInput {
  attemptId: string
  userId: string
  scenarioId: string
  scenario: ScenarioDefinition
  selectedByPhase: Record<PhaseId, string[]>
  confidence: Confidence | null
}

/**
 * Turns a submitted attempt's graded misses into remediation evidence, and mapped evidence into
 * review cards (one per user per knowledge component). Idempotent: the derivation row is claimed
 * first, so a retry or a concurrent backfill does nothing.
 */
export async function deriveRemediation(q: Queryable, input: DerivationInput, at: Date): Promise<void> {
  const pkg = contentPackage()
  const authored = pkg.remediation[input.scenarioId] ?? null
  const knownKcs = new Set(pkg.knowledge?.components.map((c) => c.id) ?? [])
  const misses = deriveMisses(input.scenario, input.selectedByPhase, input.confidence)
  if (!(await repo.claimDerivation(q, input.attemptId, at, authored?.remediationVersion ?? null, misses.length))) return

  const byKc = new Map<string, { evidenceId: string; miss: Miss }[]>()
  for (const miss of misses) {
    const mapping = authored?.mappings[miss.rubricItemId]
    const kcIds = (mapping?.kcIds ?? []).filter((kc) => knownKcs.has(kc))
    const evidenceId = await repo.insertEvidence(q, {
      userId: input.userId,
      attemptId: input.attemptId,
      scenarioId: input.scenarioId,
      rubricItemId: miss.rubricItemId,
      kind: miss.kind,
      errorType: classifyMiss(miss, misses, input.scenario, mapping),
      phase: miss.phase,
      label: miss.label,
      status: kcIds.length ? 'linked' : 'unmapped',
      kcIds,
      remediationVersion: authored?.remediationVersion ?? null,
      at,
    })
    if (!evidenceId) continue
    for (const kc of kcIds) byKc.set(kc, [...(byKc.get(kc) ?? []), { evidenceId, miss }])
  }
  if (byKc.size === 0) return

  const scheduler = getScheduler()
  await repo.ensureSchedulerParams(q, scheduler)
  for (const kcId of [...byKc.keys()].sort()) {
    const list = byKc.get(kcId)!
    const first = list[0]
    const base = { at: at.toISOString(), attemptId: input.attemptId, rubricItemId: first.miss.rubricItemId, evidenceId: first.evidenceId }
    const newMiss: DueReason = { code: 'new-miss', ...base }
    const newEvidence: DueReason = { code: 'new-evidence', ...base }
    const card = await repo.upsertCard(q, { userId: input.userId, kcId, initial: scheduler.init(at), scheduler, newMiss, newEvidence, at })
    for (const e of list) await repo.linkEvidence(q, e.evidenceId, card.id)
  }
}

/**
 * Runs derivation inside a savepoint so a remediation failure never blocks grading; the attempt is
 * then picked up by the lazy backfill on the next review request.
 */
export async function deriveRemediationSafely(q: Queryable, input: DerivationInput, at: Date): Promise<void> {
  await q.query('SAVEPOINT remediation')
  try {
    await deriveRemediation(q, input, at)
    await q.query('RELEASE SAVEPOINT remediation')
  } catch (error) {
    await q.query('ROLLBACK TO SAVEPOINT remediation')
    console.error('[remediation] derivation failed; will retry lazily', { attemptId: input.attemptId, error })
  }
}
