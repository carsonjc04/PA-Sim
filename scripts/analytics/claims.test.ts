// Guards the analytics policy: no readiness or pass prediction, no fabricated benchmarks, and no
// PACKRAT-to-PANCE conversion anywhere in shipped code. See docs/readiness-calibration-protocol.md.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { METRICS } from '../../src/domain/analytics/definitions'
import { READINESS } from '../../src/domain/analytics/readiness'

const root = join(import.meta.dirname, '../..')

const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /\bwill pass\b/i, why: 'deterministic pass language' },
  { pattern: /\blikely to pass\b/i, why: 'pass prediction' },
  { pattern: /chance of passing|probability of passing|pass(ing)?[ -]probability/i, why: 'pass probability' },
  { pattern: /readiness (score|probability|estimate)\s*[:=]/i, why: 'a readiness value' },
  { pattern: /percentile/i, why: 'percentile comparisons need a real reference population' },
  { pattern: /national (average|mean|norm|benchmark)/i, why: 'fabricated national benchmark' },
  { pattern: /packrat/i, why: 'PACKRAT-to-PANCE conversion is anecdotal, not official' },
]

/** Files allowed to mention a banned term, and why. Keep this short. */
const ALLOWED: Record<string, RegExp[]> = {
  // Says PA-Sim does NOT offer PACKRAT simulations.
  'src/features/study/StudyHome.tsx': [/packrat/i],
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(ts|tsx|css|json|html)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('analytics claims policy', () => {
  it('ships no readiness prediction, pass probability, national comparison or PACKRAT formula', () => {
    const hits: string[] = []
    for (const path of [...files(join(root, 'src')), ...files(join(root, 'server')), ...files(join(root, 'content'))]) {
      const rel = relative(root, path)
      const text = readFileSync(path, 'utf8')
      for (const { pattern, why } of BANNED) {
        const match = text.match(pattern)?.[0]
        if (!match || ALLOWED[rel]?.some((p) => p.test(match))) continue
        hits.push(`${rel}: "${match}" (${why})`)
      }
    }
    expect(hits).toEqual([])
  })

  it('keeps readiness unavailable and points to the calibration protocol', () => {
    expect(READINESS.available).toBe(false)
    expect(readFileSync(join(root, READINESS.protocol), 'utf8')).toMatch(/you will pass/i)
  })

  it('has no metric that estimates readiness or an exam outcome', () => {
    for (const m of Object.values(METRICS)) expect(`${m.id} ${m.label} ${m.description}`).not.toMatch(/readiness|predict|probability|pass rate|exam score/i)
  })
})
