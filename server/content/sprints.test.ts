import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTENT_DIR, readPackage, type RawPackage } from './loader'
import { validatePackage } from './validate'

type Json = Record<string, any>

const fresh = (): RawPackage => structuredClone(readPackage(DEFAULT_CONTENT_DIR))
const codes = (raw: RawPackage) => validatePackage(raw).errors.map((e) => e.code).filter((c) => c !== 'lock-mismatch')
const sprint = (raw: RawPackage, id = 'chest-pressure-differential') => raw.sprints[id] as Json

describe('differential sprints reuse only what their source case says', () => {
  it('ships three draft sprints that pass validation', () => {
    const result = validatePackage(fresh(), { strict: true })
    expect(result.errors).toEqual([])
    expect(result.package?.sprints.map((s) => [s.id, s.status])).toEqual([
      ['acute-dyspnea-wheeze-differential', 'draft'],
      ['chest-pressure-differential', 'draft'],
      ['cough-sore-throat-differential', 'draft'],
    ])
  })

  it('goes stale when the source case version changes', () => {
    const raw = fresh()
    sprint(raw).sourceContentVersion = '2.0.1'
    expect(codes(raw)).toContain('sprint-stale')
  })

  it('rejects a finding that is not one of the case’s history, exam or diagnostics actions', () => {
    const raw = fresh()
    sprint(raw).findingActionIds.push('made-up-finding')
    expect(codes(raw)).toContain('sprint-finding')
  })

  it('rejects options outside the case’s diagnoses, or without the correct one', () => {
    let raw = fresh()
    sprint(raw).optionIds = ['gerd', 'musculoskeletal', 'pericarditis']
    expect(codes(raw)).toEqual(expect.arrayContaining(['sprint-options']))
    raw = fresh()
    sprint(raw).optionIds = ['gerd', 'musculoskeletal', 'gerd']
    expect(codes(raw)).toContain('sprint-options')
  })

  it('rejects a finding that names the answer', () => {
    const raw = fresh()
    sprint(raw).findingActionIds.push('ecg')
    ;(raw.scenarios['chest-pressure'] as Json).phases.find((p: Json) => p.id === 'diagnostics').actions.find((a: Json) => a.id === 'ecg').response = 'ECG is consistent with acute coronary syndrome.'
    expect(codes(raw)).toContain('sprint-spoiler')
  })

  it('rejects a sprint for an unknown case', () => {
    const raw = fresh()
    sprint(raw).sourceScenarioId = 'no-such-case'
    expect(codes(raw)).toContain('sprint-source')
  })
})
