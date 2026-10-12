import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ANALYTICS_VERSION, METRICS, type MetricDefinition } from '../../src/domain/analytics/definitions'
import { fingerprintMetric, type MetricLock } from './fingerprint'

const lock: MetricLock = JSON.parse(readFileSync(join(import.meta.dirname, '../../src/domain/analytics/metric-lock.json'), 'utf8'))

describe('metric definitions are versioned', () => {
  it('matches the lock: a changed definition needs a version bump and `npm run analytics:lock`', () => {
    const problems = Object.values(METRICS).flatMap((m) => {
      const locked = lock.metrics[m.id]
      if (!locked) return [`${m.id}: not locked; run npm run analytics:lock`]
      if (locked.version !== m.version) return [`${m.id}: version ${m.version} is not locked (lock has ${locked.version}); run npm run analytics:lock`]
      if (locked.fingerprint !== fingerprintMetric(m)) return [`${m.id}: definition changed without a version bump`]
      return []
    })
    expect(problems).toEqual([])
    expect(lock.analyticsVersion).toBe(ANALYTICS_VERSION)
  })

  it('detects a formula or parameter change at the same version', () => {
    const m: MetricDefinition = METRICS.areaProficiency
    expect(fingerprintMetric({ ...m, formula: `${m.formula} Changed.` })).not.toBe(lock.metrics[m.id].fingerprint)
    expect(fingerprintMetric({ ...m, params: { ...m.params, limitedAttempts: 2 } })).not.toBe(lock.metrics[m.id].fingerprint)
    // Wording that does not change results (label, description) is not fingerprinted.
    expect(fingerprintMetric({ ...m, label: 'Renamed' })).toBe(lock.metrics[m.id].fingerprint)
  })

  it('has unique ids', () => {
    const ids = Object.values(METRICS).map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
