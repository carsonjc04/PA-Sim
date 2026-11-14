import { describe, expect, it } from 'vitest'
import { loadContent } from './package'
import { possibleMissItems } from '../../src/domain/remediation/misses'

const pkg = loadContent(undefined, { strict: true })

describe('authored review content', () => {
  it('loads for every case', () => {
    expect(Object.keys(pkg.remediation).sort()).toEqual(pkg.scenarios.map((s) => s.id).sort())
  })

  for (const s of pkg.scenarios) {
    describe(s.id, () => {
      const r = pkg.remediation[s.id]

      it('ships as draft, unreviewed content and is locked', () => {
        expect(r.provenance).toBe('author-proposed-unreviewed')
        expect(pkg.lock?.remediation?.some((e) => e.scenarioId === s.id && e.remediationVersion === r.remediationVersion)).toBe(true)
      })

      it('maps exactly the rubric items that can be missed', () => {
        expect(Object.keys(r.mappings).sort()).toEqual([...new Set(possibleMissItems(s))].sort())
      })

      it('ties every prompt to a mapped rubric item, with at least two prompt types per component', () => {
        const mapped = new Set(Object.values(r.mappings).flatMap((m) => m.kcIds))
        for (const p of r.prompts) expect(mapped.has(p.kcId), p.id).toBe(true)
        for (const kc of mapped) expect(new Set(r.prompts.filter((p) => p.kcId === kc).map((p) => p.type)).size, kc).toBeGreaterThanOrEqual(2)
      })

      it('makes no readiness or pass predictions', () => {
        const text = r.prompts.flatMap((p) => [p.front, p.answer, p.explanation, ...(p.choices ?? [])]).join('\n')
        expect(text).not.toMatch(/\b(pass(es|ed|ing)?|ready|readiness|PANCE|board|exam score|predict\w*)\b/i)
      })
    })
  }
})
