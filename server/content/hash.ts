import { createHash } from 'node:crypto'
import type { ScenarioDefinition } from '../../src/domain/types'

/** Deterministic JSON: object keys sorted so the hash reflects content, not key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Fingerprint of what a learner can experience: the whole definition except review
 * administration (status, reviews, due date, open items, changelog). A review or a status
 * change therefore never forces a content version bump, but any change to cases, scoring
 * inputs, taxonomy or references does. `content/lock.json` pins this value per released version.
 */
export function contentFingerprint(scenario: ScenarioDefinition): string {
  const { lifecycle, ...rest } = scenario
  return sha256(canonicalJson({ ...rest, contentVersion: lifecycle.contentVersion }))
}
