import { type ContentManifest } from '../../src/domain/schema'
import type { ScenarioDefinition } from '../../src/domain/types'
import { contentFingerprint } from './hash'
import { DEFAULT_CONTENT_DIR, readPackage } from './loader'
import { formatIssues, validatePackage, type Issue, type ValidateOptions, type ValidatedPackage } from './validate'

export class ContentPackageError extends Error {
  readonly issues: Issue[]
  constructor(issues: Issue[]) {
    super(`Invalid content package: ${issues.filter((i) => i.severity === 'error').length} error(s)\n${formatIssues(issues.filter((i) => i.severity === 'error'))}`)
    this.issues = issues
    this.name = 'ContentPackageError'
  }
}

export interface LoadedContent extends ValidatedPackage {
  warnings: Issue[]
  fingerprints: Record<string, string>
}

/** Reads and validates the package. Throws ContentPackageError when anything is wrong. */
export function loadContent(dir: string = DEFAULT_CONTENT_DIR, options: ValidateOptions = {}): LoadedContent {
  const result = validatePackage(readPackage(dir), options)
  if (!result.package) throw new ContentPackageError(result.issues)
  const fingerprints = Object.fromEntries(result.package.scenarios.map((s) => [s.id, contentFingerprint(s)]))
  return { ...result.package, warnings: result.warnings, fingerprints }
}

export function manifestEntry(manifest: ContentManifest, scenario: ScenarioDefinition) {
  return manifest.scenarios.find((e) => e.id === scenario.id)
}
