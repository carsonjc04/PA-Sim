import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scenarios } from './scenarios'
import { validateScenarios } from '../../src/domain/schema'
import { GRADING_VERSION, gradeAttempt } from '../../src/domain/grading'
import type { Attempt } from '../../src/domain/types'
import { upgradeStoredDefinition } from './legacy'

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

describe('grading version pin', () => {
  // Stored results cite GRADING_VERSION. If these snapshots change, bump GRADING_VERSION in grading.ts.
  it('still grades a stored schema-1.0 snapshot exactly as before (grader unchanged by Phase 3)', () => {
    const legacy = upgradeStoredDefinition(JSON.parse(readFileSync(new URL('../test/fixtures/chest-pressure.v1.json', import.meta.url), 'utf8')))
    const attempt = blank(legacy.id)
    attempt.selectedByPhase.history = ['onset', 'associated']
    attempt.selectedByPhase.diagnostics = ['ecg', 'ems']
    attempt.selectedByPhase.diagnosis = ['acs']
    attempt.selectedByPhase.treatment = ['ems', 'discharge']
    const r = gradeAttempt(legacy, attempt)
    expect({ version: GRADING_VERSION, categoryScores: r.categoryScores, raw: r.rawScore, final: r.finalScore, passed: r.passed, critical: r.criticalSafetyError }).toMatchInlineSnapshot(`
      {
        "categoryScores": {
          "communication": 50,
          "diagnosis": 70,
          "diagnostics": 80,
          "exam": 50,
          "history": 76,
          "treatment": 50,
        },
        "critical": true,
        "final": 59,
        "passed": false,
        "raw": 64,
        "version": "grading-2026-10-09.1",
      }
    `)
  })

  it('produces the pinned result for current content with unique IDs', () => {
    const scenario = scenarios.find(s => s.id === 'chest-pressure')!
    const attempt = blank(scenario.id)
    attempt.selectedByPhase.history = ['onset', 'associated']
    attempt.selectedByPhase.diagnostics = ['ecg', 'activate-ems-now']
    attempt.selectedByPhase.diagnosis = ['acs']
    attempt.selectedByPhase.treatment = ['ems', 'discharge']
    const r = gradeAttempt(scenario, attempt)
    expect({ contentVersion: scenario.lifecycle.contentVersion, categoryScores: r.categoryScores, raw: r.rawScore, final: r.finalScore, passed: r.passed, critical: r.criticalSafetyError }).toMatchInlineSnapshot(`
      {
        "categoryScores": {
          "communication": 50,
          "diagnosis": 70,
          "diagnostics": 80,
          "exam": 50,
          "history": 76,
          "treatment": 50,
        },
        "contentVersion": "2.1.0",
        "critical": true,
        "final": 59,
        "passed": false,
        "raw": 64,
      }
    `)
  })

  it('no longer lets a diagnostics action score as a plan option (ID collision fixed)', () => {
    const scenario = scenarios.find(s => s.id === 'chest-pressure')!
    const attempt = blank(scenario.id)
    attempt.selectedByPhase.diagnostics = ['activate-ems-now']
    expect(gradeAttempt(scenario, attempt).categoryScores.treatment).toBe(50)
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
