// Usage: tsx scripts/analytics/lock.ts
// Records the fingerprint of every metric definition in src/domain/analytics/metric-lock.json.
// Refuses to overwrite a locked fingerprint at the same version: change the formula, bump the version.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANALYTICS_VERSION, METRICS } from '../../src/domain/analytics/definitions'
import { fingerprintMetric, type MetricLock } from './fingerprint'

const path = join(import.meta.dirname, '../../src/domain/analytics/metric-lock.json')
const prior: MetricLock = JSON.parse(readFileSync(path, 'utf8'))
const metrics: MetricLock['metrics'] = {}
const problems: string[] = []
let changed = false
for (const m of Object.values(METRICS)) {
  const fingerprint = fingerprintMetric(m)
  const locked = prior.metrics[m.id]
  if (locked && locked.version === m.version && locked.fingerprint !== fingerprint) problems.push(`${m.id}: definition changed at version ${m.version}; bump its version`)
  if (locked && m.version < locked.version) problems.push(`${m.id}: version went backwards (${locked.version} → ${m.version})`)
  if (!locked || locked.version !== m.version) changed = true
  metrics[m.id] = { version: m.version, fingerprint }
}
if (changed && prior.analyticsVersion === ANALYTICS_VERSION && Object.keys(prior.metrics).length) problems.push('a metric version changed; bump ANALYTICS_VERSION too')
if (problems.length) {
  console.error(`[analytics] lock refused:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
writeFileSync(path, `${JSON.stringify({ analyticsVersion: ANALYTICS_VERSION, metrics }, null, 2)}\n`)
console.log(`[analytics] lock written for ${ANALYTICS_VERSION}`)
