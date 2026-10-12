import { fingerprintInput, type MetricDefinition } from '../../src/domain/analytics/definitions'
import { canonicalJson, sha256 } from '../../server/content/hash'

export interface MetricLock {
  analyticsVersion: string
  metrics: Record<string, { version: number; fingerprint: string }>
}

export const fingerprintMetric = (m: MetricDefinition) => sha256(canonicalJson(fingerprintInput(m)))
