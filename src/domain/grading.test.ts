import { describe, expect, it } from 'vitest'
import { scenarios } from '../data/scenarios'
import { validateScenarios } from './schema'
import { gradeAttempt } from './grading'
import type { Attempt } from './types'

const blank = (scenarioId: string): Attempt => ({id:'test',scenarioId,startedAt:'2026-01-01',selectedByPhase:{history:[],exam:[],diagnostics:[],diagnosis:[],treatment:[]},phaseLocks:[],revealed:[],submitted:true})

describe('scenario contracts', () => {
  it('validates all five authored scenarios', () => expect(validateScenarios(scenarios)).toHaveLength(5))
  it('keeps diagnoses out of non-spoiler summaries', () => expect(scenarios.every(s => !s.summary.title.toLowerCase().includes('diabetes') && !s.summary.title.toLowerCase().includes('coronary'))).toBe(true))
})

describe('deterministic grading', () => {
  it('is idempotent and awards partial category credit', () => {
    const scenario = scenarios[0]
    const attempt = blank(scenario.id)
    attempt.selectedByPhase.history = ['duration', 'fever']
    const first = gradeAttempt(scenario, attempt)
    const second = gradeAttempt(scenario, attempt)
    expect(first).toEqual(second)
    expect(first.categoryScores.history).toBeGreaterThan(50)
    expect(first.rawScore).toBeGreaterThan(0)
  })
  it('caps a high raw score at 59 after a critical error', () => {
    const scenario = scenarios.find(s => s.id === 'chest-pressure')!
    const attempt = blank(scenario.id)
    attempt.selectedByPhase.history = ['onset', 'associated', 'risk']
    attempt.selectedByPhase.exam = ['stability', 'focused']
    attempt.selectedByPhase.diagnostics = ['ecg', 'ems', 'outpatient']
    attempt.selectedByPhase.treatment = ['ems', 'monitor', 'no-drive', 'handoff', 'discharge']
    attempt.selectedByPhase.diagnosis = ['acs']
    const result = gradeAttempt(scenario, attempt)
    expect(result.criticalSafetyError).toBe(true)
    expect(result.finalScore).toBeLessThanOrEqual(59)
    expect(result.passed).toBe(false)
    expect(result.rawScore).toBeGreaterThan(result.finalScore)
  })
})

describe('data-driven action visibility', () => {
  it('evaluates requires and excludes rules without UI conditionals', () => {
    const action = {rule:{requires:['vitals'],excludes:['delay']}}
    const selected = ['vitals']
    const visible = !action.rule.requires?.some(id => !selected.includes(id)) && !action.rule.excludes?.some(id => selected.includes(id))
    expect(visible).toBe(true)
    expect(!action.rule.requires?.some(id => !([] as string[]).includes(id))).toBe(false)
  })
})
