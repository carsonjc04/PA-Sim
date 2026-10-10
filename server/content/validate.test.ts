import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTENT_DIR, readPackage, type RawPackage } from './loader'
import { validatePackage } from './validate'

type Json = Record<string, any>

/** A fresh in-memory copy of the shipped package that each test can break one way. */
function fresh(): RawPackage {
  return structuredClone(readPackage(DEFAULT_CONTENT_DIR))
}
const scenario = (raw: RawPackage, id = 'chest-pressure') => raw.scenarios[id] as Json
/** Error codes, excluding the version lock: tests that edit content on purpose are not about bumping versions. */
const codes = (raw: RawPackage, options = {}) => validatePackage(raw, options).errors.map((e) => e.code).filter((c) => c !== 'lock-mismatch')

describe('shipped content package', () => {
  it('has no errors, even in strict mode', () => {
    const result = validatePackage(fresh(), { strict: true })
    expect(result.errors).toEqual([])
    expect(result.package?.scenarios.map((s) => s.id).sort()).toEqual(['asthma', 'chest-pressure', 'dysuria', 'metabolic', 'respiratory'])
  })

  it('keeps every existing case a draft and never approved', () => {
    for (const s of validatePackage(fresh()).package!.scenarios) {
      expect(s.lifecycle.status).toBe('draft')
      expect(s.lifecycle.reviews).toEqual([])
    }
  })

  it('uses IDs that are unique across the whole case', () => {
    for (const s of validatePackage(fresh()).package!.scenarios) {
      const ids = [...s.phases.flatMap((p) => p.actions.map((a) => a.id)), ...s.diagnoses.map((d) => d.id), ...s.planOptions.map((p) => p.id), ...s.omissions.map((o) => o.id), ...s.criticalRules.map((r) => r.id)]
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe('structural checks', () => {
  it('rejects duplicate IDs across entity types (the old strep/pyelo/ems collisions)', () => {
    const raw = fresh()
    scenario(raw).planOptions[0].id = 'ecg'
    expect(codes(raw)).toContain('duplicate-id')
  })

  it('rejects duplicate scenario IDs in the manifest', () => {
    const raw = fresh()
    ;(raw.manifest as Json).scenarios.push({ ...(raw.manifest as Json).scenarios[0] })
    expect(codes(raw)).toContain('duplicate-scenario-id')
  })

  it('rejects a scenario file that is not in the manifest', () => {
    const raw = fresh()
    raw.scenarioFilesOnDisk.push('stray.json')
    expect(codes(raw)).toContain('orphan-file')
  })

  it('rejects a missing or reordered phase', () => {
    const raw = fresh()
    scenario(raw).phases.pop()
    expect(codes(raw)).toContain('phases-incomplete')
  })

  it('rejects an empty required phase', () => {
    const raw = fresh()
    scenario(raw).phases[0].actions = []
    expect(codes(raw)).toContain('phase-empty')
  })

  it('rejects unknown categories and malformed IDs through the strict schema', () => {
    const raw = fresh()
    scenario(raw).phases[0].actions[0].effects = [{ category: 'bedside', points: 3 }]
    expect(codes(raw)).toContain('schema')
    const raw2 = fresh()
    scenario(raw2).phases[0].actions[0].id = 'Bad ID'
    expect(codes(raw2)).toContain('schema')
  })

  it('rejects unknown fields so typos cannot silently drop content', () => {
    const raw = fresh()
    scenario(raw).correctPrimery = 'x'
    expect(codes(raw)).toContain('schema')
  })
})

describe('rubric and critical rules', () => {
  it('rejects a dangling omission target, and one filed under the wrong phase', () => {
    const raw = fresh()
    scenario(raw).omissions[0].when = ['nope']
    expect(codes(raw)).toContain('rubric-ref')
    const raw2 = fresh()
    scenario(raw2).omissions[0].phase = 'exam'
    expect(codes(raw2)).toContain('rubric-ref')
  })

  it('rejects a correctPrimary that is not a diagnosis, or two primaries', () => {
    const raw = fresh()
    scenario(raw).correctPrimary = 'ecg'
    expect(codes(raw)).toContain('rubric-ref')
    const raw2 = fresh()
    scenario(raw2).diagnoses[1].primary = true
    expect(codes(raw2)).toContain('rubric-ref')
  })

  it('rejects a critical rule aimed at a missing or harmless option', () => {
    const raw = fresh()
    scenario(raw).criticalRules[0].when = ['nope']
    expect(codes(raw)).toContain('critical-target')
    const raw2 = fresh()
    scenario(raw2).criticalRules[0].when = ['ecg']
    expect(codes(raw2)).toContain('critical-target')
  })

  it('requires every unsafe option to have a critical rule or a waiver with a reason', () => {
    const raw = fresh()
    scenario(raw, 'respiratory').criticalWaivers = []
    expect(validatePackage(raw).errors.some((e) => e.code === 'unsafe-uncovered' && e.scenarioId === 'respiratory')).toBe(true)
    const raw2 = fresh()
    scenario(raw2, 'respiratory').criticalWaivers = [{ optionId: 'antibiotics', reason: '' }]
    expect(codes(raw2)).toContain('schema')
  })

  it('records the three pending-clinical-review waivers and keeps scores unchanged', () => {
    const pkg = validatePackage(fresh()).package!
    const waivers = pkg.scenarios.flatMap((s) => s.criticalWaivers.map((w) => `${s.id}:${w.optionId}:${w.reason}`)).sort()
    expect(waivers).toEqual(['dysuria:no-treatment:pending clinical review', 'metabolic:ignore:pending clinical review', 'respiratory:antibiotics:pending clinical review'])
  })

  it('rejects a rubric with no passing path', () => {
    const raw = fresh()
    for (const p of scenario(raw).phases) for (const a of p.actions) a.effects = (a.effects ?? []).map((e: Json) => ({ ...e, points: -Math.abs(e.points) }))
    expect(codes(raw)).toContain('no-passing-path')
  })
})

describe('ActionRule static checks', () => {
  const withRules = (rules: Record<string, Json>) => {
    const raw = fresh()
    for (const p of scenario(raw, 'asthma').phases) for (const a of p.actions) if (rules[a.id]) a.rule = rules[a.id]
    return raw
  }
  it('accepts a coherent rule', () => {
    expect(codes(withRules({ lungs: { requires: ['vitals'] } }))).toEqual([])
  })
  it('rejects a missing target', () => expect(codes(withRules({ lungs: { requires: ['nope'] } }))).toContain('rule-target'))
  it('rejects requires + excludes of the same action', () => expect(codes(withRules({ lungs: { requires: ['vitals'], excludes: ['vitals'] } }))).toContain('rule-conflict'))
  it('rejects unlocks + hides of the same action', () => expect(codes(withRules({ lungs: { unlocks: ['peak'], hides: ['peak'] } }))).toContain('rule-conflict'))
  it('rejects a requires cycle as unreachable', () => {
    expect(codes(withRules({ vitals: { requires: ['lungs'] }, lungs: { requires: ['vitals'] } }))).toContain('unreachable-action')
  })
  it('rejects a requirement that only appears in a later phase', () => expect(codes(withRules({ trigger: { requires: ['reassess'] } }))).toContain('rule-order'))
  it('rejects a prerequisite chain whose members exclude each other', () => {
    expect(codes(withRules({ peak: { requires: ['lungs'] }, lungs: { requires: ['vitals'], excludes: ['vitals'] } }))).toEqual(expect.arrayContaining(['rule-conflict']))
    expect(codes(withRules({ peak: { requires: ['lungs', 'vitals'] }, lungs: { excludes: ['vitals'] } }))).toContain('rule-incompatible')
  })
})

describe('spoiler safety', () => {
  it('rejects a title, complaint or opening that names the diagnosis', () => {
    for (const field of ['title', 'complaint']) {
      const raw = fresh()
      scenario(raw).summary[field] = 'Suspected acute coronary syndrome'
      expect(codes(raw)).toContain('spoiler')
    }
    const raw = fresh()
    scenario(raw).opening = 'I think I am having a heart attack.'
    expect(codes(raw)).toContain('spoiler')
  })
  it('requires spoilerTerms so synonyms are actually checked', () => {
    const raw = fresh()
    scenario(raw).spoilerTerms = []
    expect(codes(raw)).toContain('spoiler-terms')
  })
  it('matches whole words, so "asthma-like" style substrings do not false-positive on unrelated words', () => {
    const raw = fresh()
    scenario(raw).summary.complaint = 'Pressure with an acs-free history'
    expect(codes(raw)).toContain('spoiler')
    const raw2 = fresh()
    scenario(raw2).summary.complaint = 'Chest pressure with a cactus allergy'
    expect(codes(raw2)).not.toContain('spoiler')
  })
})

describe('clinical image accessibility', () => {
  const image = (over: Json = {}) => ({ id: 'ecg-image', src: '/images/ecg.png', kind: 'ecg', alt: 'Twelve-lead tracing with ST depression', longDescription: 'A twelve-lead tracing showing ST depression in the lateral leads with a regular rhythm at ninety beats per minute.', decorative: false, revealedBy: 'ecg', licenseSource: 'Original illustration, project-owned', ...over })
  const withImage = (over?: Json) => {
    const raw = fresh()
    scenario(raw).clinicalImages = [image(over)]
    return raw
  }
  it('accepts a fully described clinical image', () => expect(codes(withImage())).toEqual([]))
  it('rejects missing, trivial or file-type alt text', () => {
    expect(codes(withImage({ alt: '' }))).toContain('image-alt')
    expect(codes(withImage({ alt: 'image' }))).toContain('image-alt')
  })
  it('rejects a clinical image without a long description or marked decorative', () => {
    expect(codes(withImage({ longDescription: '' }))).toContain('image-description')
    expect(codes(withImage({ decorative: true, alt: '' }))).toContain('image-alt')
  })
  it('requires the image to be released by a real student action, and a license', () => {
    expect(codes(withImage({ revealedBy: 'nope' }))).toContain('image-reveal')
    expect(codes(withImage({ licenseSource: '' }))).toContain('image-license')
  })
  it('rejects alt text or descriptions that spoil the diagnosis', () => {
    expect(codes(withImage({ alt: 'Tracing diagnostic of acute coronary syndrome' }))).toContain('spoiler')
  })
  it('rejects insecure or relative image sources', () => expect(codes(withImage({ src: 'http://x/y.png' }))).toContain('image-src'))
})

describe('reference metadata', () => {
  it('rejects placeholder organizations, insecure URLs and missing access dates', () => {
    const raw = fresh()
    scenario(raw).clinicalReferences[0].organization = 'ClinicSim faculty review set'
    expect(codes(raw)).toContain('reference-placeholder')
    const raw2 = fresh()
    scenario(raw2).clinicalReferences[0].url = 'http://example.org/x'
    expect(codes(raw2)).toContain('reference-url')
    const raw3 = fresh()
    delete scenario(raw3).clinicalReferences[0].accessedAt
    expect(codes(raw3)).toContain('schema')
  })
  it('rejects a source date later than the access date, and invented-looking dates', () => {
    const raw = fresh()
    scenario(raw).clinicalReferences[0].publishedOrUpdated = '2999-01-01'
    expect(codes(raw)).toContain('reference-date')
    const raw2 = fresh()
    scenario(raw2).clinicalReferences[0].publishedOrUpdated = '2026-13-45'
    expect(codes(raw2)).toContain('schema')
  })
  it('never fabricates a publication date for the shipped references', () => {
    for (const s of validatePackage(fresh()).package!.scenarios) for (const r of s.clinicalReferences) expect(r.publishedOrUpdated).toBeUndefined()
  })
  it('flags unverified and general-only references as warnings', () => {
    const w = validatePackage(fresh()).warnings.map((x) => `${x.scenarioId}:${x.code}`)
    expect(w).toEqual(expect.arrayContaining(['metabolic:reference-unverified', 'asthma:reference-general', 'chest-pressure:reference-general']))
  })
  it('keeps dysuria and metabolic flagged as needing case-specific sources', () => {
    const pkg = validatePackage(fresh()).package!
    expect(pkg.scenarios.find((s) => s.id === 'dysuria')!.lifecycle.openItems.join(' ') + pkg.scenarios.find((s) => s.id === 'dysuria')!.clinicalReferences[0].notes).toMatch(/additional case-specific sources/)
    expect(pkg.scenarios.find((s) => s.id === 'metabolic')!.clinicalReferences[0].notes).toMatch(/case-specific section/)
  })
})

describe('lifecycle and the approval guard', () => {
  const approve = (raw: RawPackage, review: Json | null, over: Json = {}) => {
    const s = scenario(raw)
    s.lifecycle.status = 'approved'
    ;(raw.manifest as Json).scenarios.find((e: Json) => e.id === s.id).status = 'approved'
    s.lifecycle.reviews = review ? [{ reviewerRole: 'MD', reviewedAt: '2026-10-09', contentVersion: s.lifecycle.contentVersion, scope: 'full case', outcome: 'approved', ...review }] : []
    Object.assign(s.lifecycle, over)
    return raw
  }
  it('refuses approved with no review', () => expect(codes(approve(fresh(), null))).toContain('approval-guard'))
  it('refuses approved on a PA-student review alone', () => {
    const raw = approve(fresh(), { reviewerRole: 'PA-student' }, { openItems: [] })
    expect(codes(raw)).toContain('approval-guard')
  })
  it('refuses approval of a different version than the one shipped', () => {
    expect(codes(approve(fresh(), { contentVersion: '1.0.0' }, { openItems: [] }))).toContain('approval-guard')
  })
  it('refuses approval while waivers, open items, unverified references or unreviewed tags remain', () => {
    const raw = approve(fresh(), {})
    const approvalIssues = validatePackage(raw).errors.filter((e) => e.code === 'approval-guard').map((e) => e.path)
    expect(approvalIssues).toEqual(expect.arrayContaining(['lifecycle.openItems', 'taxonomy.provenance', 'clinicalReferences']))
  })
  it.each(['PA-C', 'MD', 'DO', 'NP', 'PharmD'])('accepts %s as a qualifying role once every other condition is met', (role) => {
    const raw = approve(fresh(), { reviewerRole: role }, { openItems: [] })
    const s = scenario(raw)
    s.taxonomy.provenance = 'reviewed'
    s.clinicalReferences = s.clinicalReferences.map((r: Json) => ({ ...r, verified: true, specificity: 'case-specific' }))
    expect(validatePackage(raw).errors.filter((e) => e.code === 'approval-guard')).toEqual([])
  })
  it('rejects reviewer names: reviews hold roles only', () => {
    const raw = fresh()
    scenario(raw).lifecycle.reviews = [{ reviewerRole: 'MD', reviewerName: 'Someone', reviewedAt: '2026-10-09', contentVersion: '2.0.0', scope: 'x', outcome: 'comments' }]
    expect(codes(raw)).toContain('schema')
  })
  it('rejects a bad version, a missing changelog entry and a retired case that is still published', () => {
    const raw = fresh()
    scenario(raw).lifecycle.contentVersion = '2.0'
    expect(codes(raw)).toContain('schema')
    const raw2 = fresh()
    scenario(raw2).lifecycle.changeLog = []
    expect(codes(raw2)).toContain('schema')
    const raw3 = fresh()
    scenario(raw3).lifecycle.status = 'retired'
    ;(raw3.manifest as Json).scenarios.find((e: Json) => e.id === 'chest-pressure').status = 'retired'
    expect(codes(raw3)).toContain('retired-published')
  })
  it('warns, but does not fail, when a review is overdue', () => {
    const result = validatePackage(fresh(), { now: new Date('2030-01-01') })
    expect(result.errors).toEqual([])
    expect(result.warnings.some((w) => w.code === 'review-overdue')).toBe(true)
  })
  it('uses a 12 month default review interval', () => {
    for (const s of validatePackage(fresh()).package!.scenarios) expect(s.lifecycle.nextReviewDue).toBe('2027-10-10')
  })
  it('rejects unknown taxonomy terms', () => {
    const raw = fresh()
    scenario(raw).taxonomy.organSystems = ['astrology']
    expect(codes(raw)).toContain('taxonomy-term')
  })
})

describe('version lock', () => {
  it('fails when content changes without a version bump', () => {
    const raw = fresh()
    scenario(raw).opening = 'A different opening line.'
    expect(validatePackage(raw).errors.map((e) => e.code)).toContain('lock-mismatch')
  })
  it('passes after a version bump with a changelog entry, but needs a new lock entry in strict mode', () => {
    const raw = fresh()
    const s = scenario(raw)
    s.opening = 'A different opening line.'
    s.lifecycle.contentVersion = '2.0.2'
    s.lifecycle.changeLog.push({ version: '2.0.2', date: '2026-10-11', summary: 'Reworded opening.' })
    ;(raw.manifest as Json).scenarios.find((e: Json) => e.id === s.id).contentVersion = '2.0.2'
    raw.fixtures['chest-pressure'] = { ...(raw.fixtures['chest-pressure'] as Json), contentVersion: '2.0.2' }
    expect(validatePackage(raw).errors).toEqual([])
    expect(validatePackage(raw, { strict: true }).errors.map((e) => e.code)).toEqual(['lock-missing'])
  })
  it('does not require a bump for review administration changes', () => {
    const raw = fresh()
    const s = scenario(raw)
    s.lifecycle.openItems = ['Another review note.']
    s.lifecycle.status = 'clinical-review'
    ;(raw.manifest as Json).scenarios.find((e: Json) => e.id === s.id).status = 'clinical-review'
    expect(validatePackage(raw).errors.map((e) => e.code)).not.toContain('lock-mismatch')
  })
  it('refuses to go backwards or to drop a locked case', () => {
    const raw = fresh()
    ;(raw.manifest as Json).scenarios = (raw.manifest as Json).scenarios.filter((e: Json) => e.id !== 'asthma')
    expect(validatePackage(raw).errors.map((e) => e.code)).toContain('lock-orphan')
  })
})

describe('on-disk loading', () => {
  it('reports a missing file and invalid JSON instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'content-'))
    cpSync(DEFAULT_CONTENT_DIR, dir, { recursive: true })
    writeFileSync(join(dir, 'scenarios', 'asthma.json'), '{ not json')
    writeFileSync(join(dir, 'scenarios', 'asthma.fixtures.json'), readFileSync(join(dir, 'scenarios', 'dysuria.json')))
    const result = validatePackage(readPackage(dir))
    expect(result.errors.some((e) => e.code === 'json-invalid')).toBe(true)
    expect(result.package).toBeNull()
  })
})
