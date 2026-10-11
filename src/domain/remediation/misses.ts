import type { PhaseId, ScenarioDefinition } from '../types'
import { GUESSED_CORRECT_ITEM, type Confidence, type ErrorType, type Miss, type RubricMapping } from './types'

const negative = (effects?: { points: number }[]) => (effects ?? []).some((e) => e.points < 0)

/**
 * Recomputes id-level misses from the pinned case and the confirmed selections.
 *
 * Mirrors gradeAttempt (which stores prose only) so every graded miss is traceable to a rubric item:
 * - each `missed` line ↔ one `omission`
 * - each `unnecessary` line ↔ one action `unnecessary` (negatively scored)
 * - each `unsafe` line ↔ one `unsafe` action or plan option, or an `unnecessary` action that also carries unsafeReason
 * - each critical message ↔ one `critical`
 * Remediation adds three kinds the grader scores but does not list: negatively scored plan options
 * (`unnecessary`), a non-correct primary diagnosis (`wrong-diagnosis`) and a correct diagnosis recorded
 * as unsure (`guessed-correct`). Deterministic and clock-free.
 */
export function deriveMisses(s: ScenarioDefinition, selectedByPhase: Record<PhaseId, string[]>, confidence?: Confidence | null): Miss[] {
  const chosen = new Set(Object.values(selectedByPhase).flat())
  const misses: Miss[] = []
  const phaseOf = new Map<string, PhaseId>()
  const labelOf = new Map<string, string>()

  for (const p of s.phases) {
    for (const a of p.actions) {
      phaseOf.set(a.id, p.id)
      labelOf.set(a.id, a.label)
      if (!chosen.has(a.id)) continue
      if (negative(a.effects)) misses.push({ rubricItemId: a.id, kind: 'unnecessary', phase: p.id, label: a.label })
      else if (a.unsafeReason) misses.push({ rubricItemId: a.id, kind: 'unsafe', phase: p.id, label: a.label })
    }
  }
  for (const o of s.omissions) {
    if (!o.when.some((id) => chosen.has(id))) misses.push({ rubricItemId: o.id, kind: 'omission', phase: o.phase, label: o.label })
  }
  const diagnosis = s.diagnoses.find((d) => chosen.has(d.id))
  if (diagnosis && diagnosis.id !== s.correctPrimary) {
    misses.push({ rubricItemId: diagnosis.id, kind: 'wrong-diagnosis', phase: 'diagnosis', label: diagnosis.label })
  } else if (diagnosis && confidence === 'unsure') {
    misses.push({ rubricItemId: GUESSED_CORRECT_ITEM, kind: 'guessed-correct', phase: 'diagnosis', label: diagnosis.label })
  }
  for (const p of s.planOptions) {
    phaseOf.set(p.id, 'treatment')
    labelOf.set(p.id, p.label)
    if (!chosen.has(p.id)) continue
    if (p.unsafe || p.unsafeReason) misses.push({ rubricItemId: p.id, kind: 'unsafe', phase: 'treatment', label: p.label })
    else if (negative(p.effects)) misses.push({ rubricItemId: p.id, kind: 'unnecessary', phase: 'treatment', label: p.label })
  }
  for (const r of s.criticalRules) {
    const hit = r.when.find((id) => chosen.has(id))
    if (hit) misses.push({ rubricItemId: r.id, kind: 'critical', phase: phaseOf.get(hit) ?? 'treatment', label: labelOf.get(hit) ?? r.id })
  }
  return misses
}

/** Every rubric item that can ever become a miss in this case. Authored remediation must map all of them. */
export function possibleMissItems(s: ScenarioDefinition): string[] {
  return [
    ...s.phases.flatMap((p) => p.actions.filter((a) => negative(a.effects) || a.unsafeReason).map((a) => a.id)),
    ...s.omissions.map((o) => o.id),
    ...s.diagnoses.filter((d) => d.id !== s.correctPrimary).map((d) => d.id),
    GUESSED_CORRECT_ITEM,
    ...s.planOptions.filter((p) => p.unsafe || p.unsafeReason || negative(p.effects)).map((p) => p.id),
    ...s.criticalRules.map((r) => r.id),
  ]
}

/**
 * Default error type when the authored mapping does not override it. Rules apply in order:
 * 1. critical or unsafe → unsafe-action
 * 2. guessed-correct → guessed-correct
 * 3. wrong diagnosis → premature-closure if the same attempt skipped a history or exam item, else interpretation-error
 * 4. omission scored mainly against communication → communication-lapse
 * 5. omission in history, exam or diagnostics → data-gathering-omission
 * 6. anything else (unnecessary items, diagnosis/treatment omissions) → knowledge-gap
 */
export function classifyMiss(miss: Miss, all: Miss[], s: ScenarioDefinition, mapping?: RubricMapping): ErrorType {
  if (mapping?.errorType) return mapping.errorType
  if (miss.kind === 'critical' || miss.kind === 'unsafe') return 'unsafe-action'
  if (miss.kind === 'guessed-correct') return 'guessed-correct'
  if (miss.kind === 'wrong-diagnosis') {
    return all.some((m) => m.kind === 'omission' && (m.phase === 'history' || m.phase === 'exam')) ? 'premature-closure' : 'interpretation-error'
  }
  if (miss.kind === 'omission') {
    const o = s.omissions.find((x) => x.id === miss.rubricItemId)
    const weight = (category: string) => (o?.effects ?? []).filter((e) => e.category === category).reduce((n, e) => n + Math.abs(e.points), 0)
    const total = (o?.effects ?? []).reduce((n, e) => n + Math.abs(e.points), 0)
    if (total > 0 && weight('communication') * 2 > total) return 'communication-lapse'
    if (miss.phase === 'history' || miss.phase === 'exam' || miss.phase === 'diagnostics') return 'data-gathering-omission'
  }
  return 'knowledge-gap'
}
