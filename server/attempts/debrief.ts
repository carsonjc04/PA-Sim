import type { PublicChecklistItem, PublicDebriefMiss, PublicReasoningDebrief, PublicTimelineEntry } from '../../src/api/contracts'
import { deriveMisses } from '../../src/domain/remediation/misses'
import type { Confidence } from '../../src/domain/remediation/types'
import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'
import { hintEvents, keyHistoryActions, net } from './history'
import type { EventRow } from './repository'

export const REASONING_PROVENANCE =
  "Built from this case's authored reasoning and rubric and from your own choices. It is not a probability model and has not been clinically validated."


function selections(events: EventRow[]): Record<PhaseId, string[]> {
  const out: Record<PhaseId, string[]> = { history: [], exam: [], diagnostics: [], diagnosis: [], treatment: [] }
  for (const e of events) if (e.type === 'action' && e.actionId && e.confirmed && !out[e.phase].includes(e.actionId)) out[e.phase].push(e.actionId)
  return out
}

function confidenceOf(events: EventRow[]): Confidence | null {
  const dx = events.filter((e) => e.type === 'action' && e.phase === 'diagnosis' && e.confirmed).at(-1)
  const value = (dx?.detail as { confidence?: unknown } | null)?.confidence
  return value === 'sure' || value === 'unsure' ? value : null
}

/**
 * The reasoning debrief. Every sentence it shows is authored case content (omission feedback, unsafe reasons,
 * critical-rule explanations, per-option reasoning) placed along the learner's own timeline. Nothing is generated,
 * and nothing links a finding to a diagnosis beyond what the rubric already scores. Only included once submitted.
 */
export function buildReasoningDebrief(s: ScenarioDefinition, events: EventRow[], startedAt: string): PublicReasoningDebrief {
  const actions = new Map(s.phases.flatMap((p) => p.actions.map((a) => [a.id, a] as const)))
  const plans = new Map(s.planOptions.map((p) => [p.id, p]))
  const diagnoses = new Map(s.diagnoses.map((d) => [d.id, d]))
  const confidence = confidenceOf(events)
  const sel = selections(events)
  const start = Date.parse(startedAt)
  const phaseLabel = (p: PhaseId) => s.phases.find((x) => x.id === p)?.label ?? p

  const timeline: PublicTimelineEntry[] = []
  for (const e of events) {
    const offsetMs = Math.max(0, Date.parse(e.createdAt) - start)
    if (e.type === 'phase_locked') {
      timeline.push({ seq: e.seq, offsetMs, phase: e.phase, type: 'phase_locked', actionId: null, label: `${phaseLabel(e.phase)} locked`, revealed: null, source: 'system', key: false, confidence: null })
    } else if (e.type === 'action' && e.actionId && e.confirmed) {
      const source = e.source === 'voice' ? 'voice' : 'guided'
      if (e.phase === 'diagnosis') {
        const d = diagnoses.get(e.actionId)
        timeline.push({ seq: e.seq, offsetMs, phase: e.phase, type: 'diagnosis', actionId: e.actionId, label: d?.label ?? e.actionId, revealed: null, source, key: e.actionId === s.correctPrimary, confidence })
      } else if (e.phase === 'treatment') {
        const p = plans.get(e.actionId)
        timeline.push({ seq: e.seq, offsetMs, phase: e.phase, type: 'plan', actionId: e.actionId, label: p?.label ?? e.actionId, revealed: null, source, key: net(p?.effects) > 0 && !p?.unsafe, confidence: null })
      } else {
        const a = actions.get(e.actionId)
        timeline.push({ seq: e.seq, offsetMs, phase: e.phase, type: 'finding', actionId: e.actionId, label: a?.label ?? e.actionId, revealed: e.revealed, source, key: net(a?.effects) > 0 && !a?.unsafeReason, confidence: null })
      }
    }
  }

  const misses: PublicDebriefMiss[] = deriveMisses(s, sel, confidence).map((m) => {
    let why: string | null = null
    if (m.kind === 'omission') why = s.omissions.find((o) => o.id === m.rubricItemId)?.feedback ?? null
    else if (m.kind === 'critical') why = s.criticalRules.find((r) => r.id === m.rubricItemId)?.explanation ?? null
    else if (m.kind === 'wrong-diagnosis') why = diagnoses.get(m.rubricItemId)?.reasoning ?? null
    else if (m.kind === 'guessed-correct') why = 'You chose the right diagnosis but marked yourself unsure. Review what made it the best fit so the next call is confident.'
    else why = actions.get(m.rubricItemId)?.unsafeReason ?? plans.get(m.rubricItemId)?.unsafeReason ?? null
    return { rubricItemId: m.rubricItemId, kind: m.kind, phase: m.phase, label: m.label, whyItMattered: why }
  })

  const dxSeq = timeline.find((t) => t.type === 'diagnosis')?.seq ?? Number.POSITIVE_INFINITY
  const keyFindingsBeforeDiagnosis = timeline.filter((t) => t.type === 'finding' && t.key && t.seq < dxSeq).map((t) => ({ actionId: t.actionId as string, label: t.label, revealed: t.revealed }))
  const chosen = new Set(sel.diagnosis)
  const differential = s.diagnoses.map((d) => ({ id: d.id, label: d.label, correct: d.id === s.correctPrimary, chosen: chosen.has(d.id), reasoning: d.reasoning ?? null }))
  const missedEvidence = misses
    .filter((m) => m.kind === 'omission' && (m.phase === 'history' || m.phase === 'exam' || m.phase === 'diagnostics'))
    .map((m) => ({ id: m.rubricItemId, phase: m.phase, label: m.label, feedback: m.whyItMattered ?? '' }))

  // The full key-question checklist: asked, asked after a hint for that item, or missed. Times are event times
  // (transcripts are not stored).
  const hints = hintEvents(events)
  const hintSeq = new Map(hints.map((e) => [e.actionId as string, e.seq]))
  const historyChecklist: PublicChecklistItem[] = keyHistoryActions(s).map((a) => {
    const asked = events.find((e) => e.type === 'action' && e.phase === 'history' && e.actionId === a.id && e.confirmed)
    if (!asked) return { actionId: a.id, label: a.label, question: a.paText, status: 'missed', offsetMs: null, source: null }
    const hinted = (hintSeq.get(a.id) ?? Number.POSITIVE_INFINITY) < asked.seq
    return { actionId: a.id, label: a.label, question: a.paText, status: hinted ? 'asked_with_hint' : 'asked', offsetMs: Math.max(0, Date.parse(asked.createdAt) - start), source: asked.source === 'voice' ? 'voice' : 'guided' }
  })
  const modeChanges = events
    .filter((e) => e.type === 'mode_changed')
    .map((e) => ({ offsetMs: Math.max(0, Date.parse(e.createdAt) - start), mode: (e.detail as { mode?: unknown } | null)?.mode === 'voice' ? ('voice' as const) : ('guided' as const) }))

  return { misses, timeline, differential, keyFindingsBeforeDiagnosis, missedEvidence, historyChecklist, hintsUsed: hints.length, modeChanges, provenance: REASONING_PROVENANCE }
}
