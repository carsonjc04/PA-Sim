import type { AnnotationMark, AnnotationTargetKind, PublicAnnotation, PublicAttempt, PublicMedia, PublicScenario, ToolName } from '../../api/contracts'
import type { PhaseId } from '../../domain/types'

export const PHASE_TOOL: Record<'history' | 'exam' | 'diagnostics', ToolName> = {
  history: 'record_history_topics',
  exam: 'request_physical_exam',
  diagnostics: 'order_diagnostic_test',
}
export const PLAN_TOOL: Record<string, ToolName> = {
  treatment: 'propose_treatment_plan',
  counseling: 'propose_treatment_plan',
  disposition: 'record_disposition',
  'follow-up': 'record_follow_up',
  return: 'record_follow_up',
}

/**
 * What a case entry is. Each kind has its own label, icon and shape, so the distinction never depends on color:
 * patient statements, observed findings, test results, the learner's own notes and system feedback.
 */
export type EntryKind = 'patient' | 'finding' | 'result' | 'note' | 'system'

export const ENTRY_LABEL: Record<EntryKind, string> = {
  patient: 'Patient said',
  finding: 'Exam finding',
  result: 'Test result',
  note: 'Your note',
  system: 'ClinicSim',
}

export interface CaseEntryData {
  id: string
  kind: EntryKind
  /** Visible label; defaults to ENTRY_LABEL[kind]. */
  label?: string
  /** Secondary context, e.g. the question asked or "from voice". */
  context?: string
  text: string
  /** The action that revealed it, so it can be annotated. */
  actionId?: string
  tone?: 'info' | 'warning' | 'error'
  /** Clinical images this finding released. */
  media?: PublicMedia[]
}

export const entryKindForPhase = (phase: PhaseId): EntryKind => (phase === 'history' ? 'patient' : phase === 'exam' ? 'finding' : 'result')

/** The case surface: opening statement, presentation findings and every revealed answer, finding or result, in order. */
export function buildEntries(attempt: PublicAttempt): CaseEntryData[] {
  const s = attempt.scenario
  const labelOf = new Map(s.phases.flatMap((p) => p.actions.map((a) => [a.id, a.label] as const)))
  const entries: CaseEntryData[] = [{ id: 'opening', kind: 'patient', label: `${s.patient.name} said`, text: s.opening }]
  if (s.initialInfo.length) entries.push({ id: 'presentation', kind: 'finding', label: 'At presentation', text: s.initialInfo.join(' · ') })
  for (const e of attempt.events) {
    if (!e.revealed || e.phase === 'diagnosis' || e.phase === 'treatment') continue
    const kind = entryKindForPhase(e.phase)
    entries.push({
      id: `event-${e.seq}`,
      kind,
      context: [labelOf.get(e.actionId), e.source === 'voice' ? 'from voice' : null].filter(Boolean).join(' · ') || undefined,
      text: e.revealed,
      actionId: e.actionId,
      ...(e.media?.length ? { media: e.media } : {}),
    })
  }
  return entries
}

export interface OptionData {
  id: string
  label: string
  hint: string
  targetKind: AnnotationTargetKind
}

export function optionsFor(s: PublicScenario, phase: PhaseId): OptionData[] {
  if (phase === 'diagnosis') return s.diagnoses.map((d) => ({ id: d.id, label: d.label, hint: 'Primary diagnosis', targetKind: 'diagnosis' }))
  if (phase === 'treatment') return s.planOptions.map((p) => ({ id: p.id, label: p.label, hint: planGroupLabel(p.group), targetKind: 'plan' }))
  return (s.phases.find((p) => p.id === phase)?.actions ?? []).map((a) => ({ id: a.id, label: a.label, hint: a.paText, targetKind: 'action' }))
}

const planGroupLabel = (group: string) =>
  ({ treatment: 'Treatment', disposition: 'Disposition', counseling: 'Counseling', return: 'Return precautions', 'follow-up': 'Follow-up' })[group] ?? 'Plan'

/** Groups chosen plan options by the tool that records them (one event per tool, as the guided flow always has). */
export function planEvents(s: PublicScenario, chosen: string[]): { tool: ToolName; actionIds: string[] }[] {
  const byTool = new Map<ToolName, string[]>()
  for (const id of chosen) {
    const group = s.planOptions.find((p) => p.id === id)?.group
    const tool = group ? PLAN_TOOL[group] : undefined
    if (tool) byTool.set(tool, [...(byTool.get(tool) ?? []), id])
  }
  return [...byTool].map(([tool, actionIds]) => ({ tool, actionIds }))
}

export const MARK_LABEL: Record<AnnotationMark, string> = { ruled_out: 'Ruled out', key: 'Key', revisit: 'Revisit' }
export const MARK_ACTION: Record<AnnotationMark, string> = { ruled_out: 'Rule out', key: 'Mark key', revisit: 'Flag to revisit' }
export const MARK_KEY: Record<AnnotationMark, string> = { ruled_out: 'x', key: 'h', revisit: 'f' }

export const marksFor = (annotations: PublicAnnotation[], kind: AnnotationTargetKind, id: string): AnnotationMark[] =>
  annotations.find((a) => a.targetKind === kind && a.targetId === id)?.marks ?? []
