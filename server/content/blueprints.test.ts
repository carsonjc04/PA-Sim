import { describe, expect, it } from 'vitest'
import { blueprintLifecycle, defaultBlueprint, selectableBlueprints } from '../../src/domain/study/blueprints'
import type { Blueprint } from '../../src/domain/study/schema'
import { DEFAULT_CONTENT_DIR, readPackage, type RawPackage } from './loader'
import { loadContent } from './package'
import { validatePackage } from './validate'

type Json = Record<string, any>

const pkg = loadContent()
const vocab = pkg.taxonomy
const blueprints = pkg.blueprints
const fresh = (): RawPackage => structuredClone(readPackage(DEFAULT_CONTENT_DIR))
const codes = (raw: RawPackage) => validatePackage(raw).errors.map((e) => e.code)
const bp = (raw: RawPackage, id: string) => raw.blueprints[id] as Json
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0)
const ROTATIONS = ['emergency-medicine', 'family-medicine', 'internal-medicine', 'pediatrics', 'surgery', 'psychiatry-behavioral-health', 'women-s-health']
const TODAY = '2026-10-11'

describe('shipped blueprints', () => {
  it('includes the PANCE blueprint effective January 2025 and current plus legacy EOR blueprints', () => {
    expect(blueprints.map((b) => b.id).sort()).toEqual([
      'nccpa-pance-2025',
      'paea-eor-emergency-medicine-2018',
      'paea-eor-emergency-medicine-2026',
      'paea-eor-family-medicine-2018',
      'paea-eor-family-medicine-2026',
      'paea-eor-gynecologic-sexual-reproductive-health-2026',
      'paea-eor-internal-medicine-2018',
      'paea-eor-internal-medicine-2026',
      'paea-eor-pediatrics-2018',
      'paea-eor-pediatrics-2026',
      'paea-eor-psychiatry-behavioral-health-2018',
      'paea-eor-psychiatry-behavioral-health-2026',
      'paea-eor-surgery-2023',
      'paea-eor-womens-health-2018',
    ])
    expect(blueprints.find((b) => b.id === 'nccpa-pance-2025')?.effectiveFrom).toBe('2025-01-01')
  })

  it('records source URL, checksum, retrieval date and date wording for every version', () => {
    for (const b of blueprints) {
      expect(b.source.documentUrl, b.id).toMatch(/^https:\/\/.+\.pdf$/)
      expect(b.source.landingPage, b.id).toMatch(/^https:\/\//)
      expect(b.source.sha256, b.id).toMatch(/^[0-9a-f]{64}$/)
      expect(b.source.retrievedAt, b.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(b.dateNotes.length, b.id).toBeGreaterThan(20)
      if (b.source.retrievedVia) expect(b.source.retrievalNote, b.id).toBeTruthy()
    }
  })
})

describe('taxonomy completeness', () => {
  const active = (list: { id: string; status: string }[]) => new Set(list.filter((t) => t.status === 'active').map((t) => t.id))

  it('crosswalks every blueprint category to active canonical tags', () => {
    const sets = { organSystems: active(vocab.organSystems), panceTasks: active(vocab.panceTasks), topicTags: active(vocab.topicTags), careSettings: active(vocab.careSettings), ageGroups: active(vocab.ageGroups) }
    for (const b of blueprints) {
      for (const c of b.contentCategories) {
        expect(c.crosswalk.anyOf.length, `${b.id}/${c.id}`).toBeGreaterThan(0)
        for (const clause of c.crosswalk.anyOf) {
          for (const [field, ids] of Object.entries(clause)) for (const id of ids as string[]) expect(sets[field as keyof typeof sets].has(id), `${b.id}/${c.id}: ${field} ${id}`).toBe(true)
        }
      }
      for (const t of b.taskCategories) expect(sets.panceTasks.has(t.canonicalTask), `${b.id}/${t.id}`).toBe(true)
    }
  })

  it('makes the PANCE content and task axes exactly the canonical organ-system and task vocabularies', () => {
    const pance = blueprints.find((b) => b.exam === 'pance')!
    expect(pance.contentCategories.map((c) => c.id).sort()).toEqual([...active(vocab.organSystems)].sort())
    expect(pance.taskCategories.map((t) => t.canonicalTask).sort()).toEqual([...active(vocab.panceTasks)].sort())
    for (const c of pance.contentCategories) expect(c.crosswalk.anyOf.some((cl) => cl.organSystems?.includes(c.id)), c.id).toBe(true)
  })

  it('has a current blueprint for PANCE and for each of the seven core rotations', () => {
    expect(defaultBlueprint(blueprints, TODAY, { exam: 'pance' })?.id).toBe('nccpa-pance-2025')
    for (const r of ROTATIONS) {
      const d = defaultBlueprint(blueprints, TODAY, { rotation: r })
      expect(d, r).not.toBeNull()
      expect(blueprintLifecycle(d!, blueprints, TODAY), r).toBe('current')
    }
  })
})

describe('weight totals', () => {
  it.each(blueprints.map((b) => [b.id, b] as [string, Blueprint]))('%s: content and task weights each total 100%%', (_id, b) => {
    expect(sum(b.contentCategories.map((c) => c.weightPct))).toBe(100)
    expect(sum(b.taskCategories.map((t) => t.weightPct))).toBe(100)
  })

  it.each(blueprints.filter((b) => b.cells).map((b) => [b.id, b] as [string, Blueprint]))('%s: every row and column of the item matrix matches its stated percentage', (_id, b) => {
    const cells = b.cells!
    expect(cells).toHaveLength(b.contentCategories.length * b.taskCategories.length)
    expect(sum(cells.map((c) => c.items))).toBe(b.examStructure.items)
    for (const c of b.contentCategories) expect(sum(cells.filter((x) => x.content === c.id).map((x) => x.items)), c.id).toBe(c.weightPct)
    for (const t of b.taskCategories) expect(sum(cells.filter((x) => x.task === t.id).map((x) => x.items)), t.id).toBe(t.weightPct)
  })

  it('makes partition targets total 100% (Surgery perioperative setting)', () => {
    const periop = blueprints.find((b) => b.id === 'paea-eor-surgery-2023')!.secondaryTargets!.find((t) => t.partition)!
    expect(sum(periop.values.map((v) => v.minPct))).toBe(100)
  })

  it('rejects a mistyped cell, a dropped category and a wrong total', () => {
    let raw = fresh()
    bp(raw, 'paea-eor-family-medicine-2026').cells[0].items += 1
    expect(codes(raw)).toContain('blueprint-cells')
    raw = fresh()
    bp(raw, 'nccpa-pance-2025').contentCategories.pop()
    expect(codes(raw)).toContain('blueprint-weights')
    raw = fresh()
    bp(raw, 'nccpa-pance-2025').taskCategories[0].weightPct = 17
    expect(codes(raw)).toContain('blueprint-weights')
  })
})

describe('retired blueprint versions', () => {
  it('treats the 2018 EOR blueprints as legacy (still selectable) until the end of July 2027', () => {
    const legacy = blueprints.find((b) => b.id === 'paea-eor-family-medicine-2018')!
    expect(blueprintLifecycle(legacy, blueprints, TODAY)).toBe('legacy')
    expect(selectableBlueprints(blueprints, TODAY, { rotation: 'family-medicine' }).map((b) => b.id)).toEqual(['paea-eor-family-medicine-2026', 'paea-eor-family-medicine-2018'])
    expect(blueprintLifecycle(legacy, blueprints, '2027-07-31')).toBe('legacy')
  })

  it('retires them after July 2027: excluded from selection but still resolvable for history', () => {
    const after = '2027-08-01'
    for (const r of ROTATIONS.filter((r) => r !== 'surgery')) {
      const ids = selectableBlueprints(blueprints, after, { rotation: r }).map((b) => b.id)
      expect(ids.some((id) => id.endsWith('-2018')), r).toBe(false)
      expect(ids.length, r).toBe(1)
    }
    const legacy = blueprints.find((b) => b.id === 'paea-eor-womens-health-2018')!
    expect(blueprintLifecycle(legacy, blueprints, after)).toBe('retired')
    expect(blueprints.some((b) => b.id === legacy.id)).toBe(true)
  })

  it('has a symmetric legacy -> current succession for every revised rotation', () => {
    for (const b of blueprints.filter((x) => x.supersededBy)) {
      const next = blueprints.find((x) => x.id === b.supersededBy)!
      expect(next.supersedes).toContain(b.id)
      expect(next.rotation).toBe(b.rotation)
    }
  })

  it('handles a synthetic retired version with no successor', () => {
    const base = blueprints.find((b) => b.id === 'paea-eor-surgery-2023')!
    const retired: Blueprint = { ...base, id: 'paea-eor-surgery-2010', versionLabel: '2010', effectiveUntil: '2015-12-31' }
    const all = [...blueprints, retired]
    expect(blueprintLifecycle(retired, all, TODAY)).toBe('retired')
    expect(selectableBlueprints(all, TODAY, { rotation: 'surgery' }).map((b) => b.id)).toEqual(['paea-eor-surgery-2023'])
  })

  it('marks a version upcoming before its effective date', () => {
    const current = blueprints.find((b) => b.id === 'paea-eor-pediatrics-2026')!
    expect(blueprintLifecycle(current, blueprints, '2026-07-01')).toBe('upcoming')
    expect(defaultBlueprint(blueprints, '2026-07-01', { rotation: 'pediatrics' })?.id).toBe('paea-eor-pediatrics-2018')
  })

  it('rejects broken succession links and a rotation without a blueprint', () => {
    let raw = fresh()
    bp(raw, 'paea-eor-pediatrics-2026').supersedes = []
    expect(codes(raw)).toContain('blueprint-succession')
    raw = fresh()
    delete raw.blueprints['paea-eor-surgery-2023']
    expect(codes(raw)).toContain('blueprint-missing')
  })

  it('rejects a crosswalk to a deprecated tag', () => {
    const raw = fresh()
    bp(raw, 'nccpa-pance-2025').contentCategories[0].crosswalk.anyOf.push({ panceTasks: ['patient-education'] })
    expect(codes(raw)).toContain('blueprint-crosswalk-deprecated')
  })
})
