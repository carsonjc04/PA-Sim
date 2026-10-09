import { createHash } from 'node:crypto'
import { scenarios } from '../../src/data/scenarios'
import { GRADING_VERSION } from '../../src/domain/grading'
import { validateScenario } from '../../src/domain/schema'
import type { ScenarioDefinition } from '../../src/domain/types'
import { ApiError } from '../http/errors'

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

export interface CurrentContent {
  id: string
  hash: string
  scenario: ScenarioDefinition
}

export function contentVersionOf(scenario: ScenarioDefinition): CurrentContent {
  const hash = sha256(canonicalJson(scenario))
  return { id: `${scenario.id}@${hash.slice(0, 12)}`, hash, scenario }
}

export function currentScenarios(): ScenarioDefinition[] {
  return scenarios.map(validateScenario)
}

export function currentContent(scenarioId: string): CurrentContent {
  const found = scenarios.find((s) => s.id === scenarioId)
  if (!found) throw new ApiError('Scenario not found', 404, 'scenario_not_found')
  return contentVersionOf(validateScenario(found))
}

export { GRADING_VERSION }
