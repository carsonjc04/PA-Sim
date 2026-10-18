import type { HistoryMode, PublicHint } from '../../src/api/contracts'
import type { Action, ScenarioDefinition } from '../../src/domain/types'
import type { EventRow } from './repository'

export const net = (effects?: { points: number }[]) => (effects ?? []).reduce((n, e) => n + e.points, 0)

/** Authored history items the rubric scores as positive: the key questions. Distractors never qualify. */
export const keyHistoryActions = (s: ScenarioDefinition): Action[] =>
  (s.phases.find((p) => p.id === 'history')?.actions ?? []).filter((a) => net(a.effects) > 0 && !a.unsafeReason)

export function historyModeOf(events: EventRow[]): HistoryMode {
  const last = events.filter((e) => e.type === 'mode_changed').at(-1)
  return (last?.detail as { mode?: unknown } | null)?.mode === 'voice' ? 'voice' : 'guided'
}

export const hintEvents = (events: EventRow[]) => events.filter((e) => e.type === 'hint_used' && e.actionId)

export function hintsOf(s: ScenarioDefinition, events: EventRow[]): PublicHint[] {
  const actions = new Map(keyHistoryActions(s).map((a) => [a.id, a]))
  return hintEvents(events).map((e) => ({ seq: e.seq, actionId: e.actionId as string, text: actions.get(e.actionId as string)?.paText ?? '', at: e.createdAt }))
}

/** The next key question in authored order that was neither asked nor already hinted, or null. */
export function nextHint(s: ScenarioDefinition, events: EventRow[]): Action | null {
  const used = new Set(events.filter((e) => (e.type === 'action' && e.phase === 'history') || e.type === 'hint_used').map((e) => e.actionId))
  return keyHistoryActions(s).find((a) => !used.has(a.id)) ?? null
}
