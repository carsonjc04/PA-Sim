import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeCoverage, type StudyItem } from '../../src/domain/study/coverage'
import { canonicalTags, resolveTerms } from '../../src/domain/study/taxonomy'
import { upgradeStoredDefinition } from './legacy'
import { DEFAULT_CONTENT_DIR, readPackage, type RawPackage } from './loader'
import { loadContent } from './package'
import { validatePackage } from './validate'

type Json = Record<string, any>

const pkg = loadContent()
const vocab = pkg.taxonomy
const fresh = (): RawPackage => structuredClone(readPackage(DEFAULT_CONTENT_DIR))
const codes = (raw: RawPackage) => validatePackage(raw).errors.map((e) => e.code).filter((c) => c !== 'lock-mismatch')
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'))
const HM = 'health-maintenance-education-prevention'
const AXES = ['organSystems', 'panceTasks', 'topicTags', 'careSettings', 'ageGroups', 'eorRotations'] as const

describe('historical tag stability', () => {
  it('keeps every ID ever published in the vocabulary', () => {
    for (const axis of AXES) {
      const ids = new Set(vocab[axis].map((t) => t.id))
      for (const id of pkg.taxonomyHistory!.axes[axis]) expect(ids.has(id), `${axis}: ${id}`).toBe(true)
    }
  })

  it('keeps the pre-2.0 task IDs, deprecated and pointing at the official merged category', () => {
    for (const id of ['health-maintenance', 'patient-education', 'preventive-measures']) {
      const term = vocab.panceTasks.find((t) => t.id === id)
      expect(term, id).toMatchObject({ status: 'deprecated', replacedBy: [HM] })
    }
  })

  it('reads a stored snapshot tagged with a deprecated ID without rewriting it, and resolves it to the current category', () => {
    const stored = fixture('metabolic.v1.0.1.json')
    const before = JSON.stringify(stored)
    const upgraded = upgradeStoredDefinition(stored)
    expect(JSON.stringify(stored)).toBe(before)
    expect(upgraded.taxonomy.panceTasks).toContain('patient-education')
    const tags = canonicalTags(upgraded.taxonomy, vocab)
    expect(tags.panceTasks).toEqual(['history-taking-physical-examination', 'using-diagnostic-laboratory-studies', 'formulating-the-most-likely-diagnosis', HM])
    expect(tags.organSystems).toEqual(['endocrine-system'])
    expect(tags.eorRotations).toEqual(['family-medicine', 'internal-medicine'])
  })

  it('counts that historical snapshot under the same blueprint categories as the current version', () => {
    const pance = pkg.blueprints.find((b) => b.id === 'nccpa-pance-2025')!
    const item = (id: string, taxonomy: Json): StudyItem => ({ id, title: id, kind: 'case', tags: canonicalTags(taxonomy as never, vocab), status: 'draft', blueprintReviews: [] })
    const old = computeCoverage(pance, [item('old', upgradeStoredDefinition(fixture('metabolic.v1.0.1.json')).taxonomy)])
    const now = computeCoverage(pance, [item('now', pkg.scenarios.find((s) => s.id === 'metabolic')!.taxonomy)])
    const touched = (c: typeof old) => c.cells.filter((x) => x.itemIds.length).map((x) => `${x.content}|${x.task}`)
    expect(touched(old)).toEqual(touched(now))
    expect(touched(old)).toContain(`endocrine-system|${HM}`)
  })

  it('reads a schema-1.0 snapshot (no taxonomy at all) as untagged rather than failing', () => {
    const upgraded = upgradeStoredDefinition(fixture('chest-pressure.v1.json'))
    expect(canonicalTags(upgraded.taxonomy, vocab).organSystems).toEqual([])
  })

  it('follows replacement chains and keeps unknown IDs instead of dropping them', () => {
    const terms = [
      { id: 'a', label: 'A', status: 'deprecated' as const, replacedBy: ['b'] },
      { id: 'b', label: 'B', status: 'deprecated' as const, replacedBy: ['c'] },
      { id: 'c', label: 'C', status: 'active' as const },
    ]
    expect(resolveTerms(['a', 'c', 'zzz'], terms)).toEqual(['c', 'zzz'])
  })
})

describe('taxonomy history enforcement', () => {
  it('rejects deleting a published ID', () => {
    const raw = fresh()
    ;(raw.taxonomy as Json).panceTasks = (raw.taxonomy as Json).panceTasks.filter((t: Json) => t.id !== 'patient-education')
    expect(codes(raw)).toContain('taxonomy-id-removed')
  })

  it('rejects a new ID that is not recorded in the history', () => {
    const raw = fresh()
    ;(raw.taxonomy as Json).topicTags.push({ id: 'brand-new', label: 'Brand new', status: 'active' })
    expect(codes(raw)).toContain('taxonomy-history-stale')
  })

  it('rejects a deprecated ID without a valid replacement', () => {
    const raw = fresh()
    const term = (raw.taxonomy as Json).panceTasks.find((t: Json) => t.id === 'preventive-measures')
    delete term.replacedBy
    expect(codes(raw)).toContain('taxonomy-replacement')
  })

  it('rejects deprecated IDs in current case content', () => {
    const raw = fresh()
    ;(raw.scenarios.metabolic as Json).taxonomy.panceTasks.push('patient-education')
    expect(codes(raw)).toContain('taxonomy-deprecated')
  })

  it('rejects a case without suitability metadata or claiming an unbuilt mode', () => {
    let raw = fresh()
    delete (raw.scenarios.asthma as Json).taxonomy.suitability
    expect(codes(raw)).toContain('schema')
    raw = fresh()
    ;(raw.scenarios.asthma as Json).taxonomy.suitability.modes = ['clinical-sim']
    expect(codes(raw)).toContain('suitability-mode')
  })

  it('rejects a blueprint review naming an unknown blueprint version', () => {
    const raw = fresh()
    ;(raw.scenarios.asthma as Json).taxonomy.blueprintReviews = [{ blueprintId: 'nccpa-pance-2019', reviewerRole: 'PA-C', reviewedAt: '2026-10-01' }]
    expect(codes(raw)).toContain('taxonomy-blueprint-review')
  })
})
