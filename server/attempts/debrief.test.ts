import { describe, expect, it } from 'vitest'
import type { PhaseId, ScenarioDefinition } from '../../src/domain/types'
import { contentPackage } from '../content/scenarios'
import { buildReasoningDebrief, REASONING_PROVENANCE } from './debrief'
import type { EventRow } from './repository'

const pkg = contentPackage()
const scenario = (id: string) => pkg.scenarios.find((s) => s.id === id) as ScenarioDefinition
const fixture = (id: string, kind: string) => pkg.fixtures[id].fixtures.find((f) => f.kind === kind)!.selections as Record<PhaseId, string[]>
const START = '2026-10-11T10:00:00.000Z'

/** Events as the guided flow records them: choices per phase, then a lock; diagnosis with confidence. */
function eventsFor(s: ScenarioDefinition, sel: Record<PhaseId, string[]>, confidence?: 'sure' | 'unsure'): EventRow[] {
  const out: EventRow[] = []
  let seq = 0
  const at = () => new Date(Date.parse(START) + seq * 30_000).toISOString() // called after seq is incremented
  const response = (id: string) => s.phases.flatMap((p) => p.actions).find((a) => a.id === id)?.response ?? null
  for (const phase of ['history', 'exam', 'diagnostics', 'diagnosis', 'treatment'] as const) {
    for (const id of sel[phase]) {
      out.push({ seq: ++seq, type: 'action', phase, actionId: id, kind: 'action', confirmed: true, revealed: phase === 'diagnosis' || phase === 'treatment' ? null : response(id), source: 'guided', detail: phase === 'diagnosis' && confidence ? { confidence } : null, createdAt: at() })
    }
    if (phase !== 'treatment') out.push({ seq: ++seq, type: 'phase_locked', phase, actionId: null, kind: null, confirmed: true, revealed: null, source: 'system', detail: null, createdAt: at() })
  }
  return out
}

describe('reasoning debrief', () => {
  it('explains each miss with verbatim authored text', () => {
    const s = scenario('respiratory')
    const sel = fixture('respiratory', 'happy-path')
    sel.history = sel.history.filter((id) => id !== 'redflags')
    const d = buildReasoningDebrief(s, eventsFor(s, sel), START)
    const omission = d.misses.find((m) => m.kind === 'omission')!
    expect(omission.whyItMattered).toBe(s.omissions.find((o) => o.id === omission.rubricItemId)!.feedback)
    expect(d.missedEvidence.map((m) => m.id)).toContain(omission.rubricItemId)
    expect(d.provenance).toBe(REASONING_PROVENANCE)
  })

  it('uses the critical rule explanation and the wrong option reasoning', () => {
    const cp = scenario('chest-pressure')
    const critical = buildReasoningDebrief(cp, eventsFor(cp, fixture('chest-pressure', 'critical-safety-miss')), START)
    const c = critical.misses.find((m) => m.kind === 'critical')!
    expect(c.whyItMattered).toBe(cp.criticalRules.find((r) => r.id === c.rubricItemId)!.explanation)
    const wrong = buildReasoningDebrief(cp, eventsFor(cp, fixture('chest-pressure', 'wrong-path')), START)
    const w = wrong.misses.find((m) => m.kind === 'wrong-diagnosis')!
    expect(w.whyItMattered).toBe(cp.diagnoses.find((x) => x.id === w.rubricItemId)!.reasoning ?? null)
  })

  it('orders the timeline, marks phase locks and flags rubric-key findings', () => {
    const s = scenario('respiratory')
    const d = buildReasoningDebrief(s, eventsFor(s, fixture('respiratory', 'happy-path'), 'sure'), START)
    expect(d.timeline.map((t) => t.seq)).toEqual([...d.timeline.map((t) => t.seq)].sort((a, b) => a - b))
    expect(d.timeline.filter((t) => t.type === 'phase_locked').map((t) => t.phase)).toEqual(['history', 'exam', 'diagnostics', 'diagnosis'])
    expect(d.timeline[0].offsetMs).toBe(30_000)
    for (const t of d.timeline.filter((x) => x.type === 'finding')) {
      const a = s.phases.flatMap((p) => p.actions).find((x) => x.id === t.actionId)!
      expect(t.key, t.label).toBe((a.effects ?? []).reduce((n, e) => n + e.points, 0) > 0 && !a.unsafeReason)
    }
    expect(d.timeline.find((t) => t.type === 'diagnosis')).toMatchObject({ actionId: s.correctPrimary, key: true, confidence: 'sure' })
  })

  it('lists key findings gathered before the diagnosis, and the whole authored differential', () => {
    const s = scenario('respiratory')
    const sel = fixture('respiratory', 'happy-path')
    const d = buildReasoningDebrief(s, eventsFor(s, sel), START)
    expect(d.keyFindingsBeforeDiagnosis.length).toBeGreaterThan(0)
    expect(d.keyFindingsBeforeDiagnosis.every((f) => d.timeline.find((t) => t.actionId === f.actionId)!.key)).toBe(true)
    expect(d.differential.map((o) => o.id)).toEqual(s.diagnoses.map((x) => x.id))
    expect(d.differential.find((o) => o.correct)!.id).toBe(s.correctPrimary)
    expect(d.differential.find((o) => o.chosen)!.id).toBe(sel.diagnosis[0])
    expect(d.differential.every((o) => o.reasoning === (s.diagnoses.find((x) => x.id === o.id)!.reasoning ?? null))).toBe(true)
  })

  it('treats an unsure correct diagnosis as something to firm up', () => {
    const s = scenario('respiratory')
    const d = buildReasoningDebrief(s, eventsFor(s, fixture('respiratory', 'happy-path'), 'unsure'), START)
    expect(d.misses.find((m) => m.kind === 'guessed-correct')?.whyItMattered).toMatch(/marked yourself unsure/)
  })
})
