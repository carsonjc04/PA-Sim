import { GRADING_VERSION } from '../../src/domain/grading'
import type { ScenarioDefinition } from '../../src/domain/types'
import { ApiError } from '../http/errors'
import { canonicalJson, sha256 } from './hash'
import { contentPackage } from './scenarios'

export { canonicalJson, sha256, GRADING_VERSION }

export interface CurrentContent {
  id: string
  hash: string
  /** Human-readable semantic version of the case (lifecycle.contentVersion). */
  semver: string
  /** Version of the content package that shipped this case. */
  manifestVersion: string
  scenario: ScenarioDefinition
}

/** Exact snapshot identity: `<scenarioId>@<first 12 hex of the whole definition's hash>`. Never reused for different content. */
export function contentVersionOf(scenario: ScenarioDefinition, manifestVersion = contentPackage().manifest.manifestVersion): CurrentContent {
  const hash = sha256(canonicalJson(scenario))
  return { id: `${scenario.id}@${hash.slice(0, 12)}`, hash, semver: scenario.lifecycle.contentVersion, manifestVersion, scenario }
}

/** Cases offered to learners: published, and never retired. */
export function currentScenarios(): ScenarioDefinition[] {
  const pkg = contentPackage()
  const published = new Set(pkg.manifest.scenarios.filter((e) => e.published).map((e) => e.id))
  return pkg.scenarios.filter((s) => published.has(s.id) && s.lifecycle.status !== 'retired')
}

/** The content new attempts start on. Retired or unpublished cases are refused; stored attempts still load from their pinned snapshot. */
export function currentContent(scenarioId: string): CurrentContent {
  const found = contentPackage().scenarios.find((s) => s.id === scenarioId)
  if (!found) throw new ApiError('Scenario not found', 404, 'scenario_not_found')
  if (!currentScenarios().some((s) => s.id === scenarioId)) {
    throw new ApiError('This scenario has been retired and cannot be started.', 410, 'scenario_retired')
  }
  return contentVersionOf(found)
}
