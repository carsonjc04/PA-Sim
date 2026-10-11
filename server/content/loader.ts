import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Issue } from './validate'

export const DEFAULT_CONTENT_DIR = fileURLToPath(new URL('../../content', import.meta.url))

export interface RawPackage {
  dir: string
  manifest: unknown
  lock: unknown
  taxonomy: unknown
  /** Raw scenario JSON by manifest id. */
  scenarios: Record<string, unknown>
  fixtures: Record<string, unknown>
  /** Scenario file names found on disk, relative to `scenarios/`. */
  scenarioFilesOnDisk: string[]
  /** content/knowledge/library.json, or undefined when no remediation content exists. */
  knowledge: unknown
  /** Raw remediation sidecars by file stem (content/remediation/<scenarioId>.json). */
  remediation: Record<string, unknown>
  /** content/taxonomy-history.json: every taxonomy ID ever published. */
  taxonomyHistory: unknown
  /** Raw exam blueprints by file stem (content/blueprints/<id>.json). */
  blueprints: Record<string, unknown>
  /** Raw differential sprints by file stem (content/sprints/<id>.json). */
  sprints: Record<string, unknown>
  loadIssues: Issue[]
}

function readJson(path: string, label: string, issues: Issue[], scenarioId?: string): unknown {
  if (!existsSync(path)) {
    issues.push({ severity: 'error', code: 'file-missing', scenarioId, path: label, message: `Missing file ${label}` })
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    issues.push({ severity: 'error', code: 'json-invalid', scenarioId, path: label, message: `${label} is not valid JSON: ${(error as Error).message}` })
    return undefined
  }
}

/** Reads the package from disk without validating it; every problem becomes an issue. */
export function readPackage(dir: string = DEFAULT_CONTENT_DIR): RawPackage {
  const loadIssues: Issue[] = []
  const root = resolve(dir)
  const manifest = readJson(join(root, 'manifest.json'), 'manifest.json', loadIssues)
  const lock = readJson(join(root, 'lock.json'), 'lock.json', loadIssues)
  const taxonomy = readJson(join(root, 'taxonomy.json'), 'taxonomy.json', loadIssues)

  const scenarios: Record<string, unknown> = {}
  const fixtures: Record<string, unknown> = {}
  const entries = (manifest as { scenarios?: { id?: unknown; file?: unknown }[] } | undefined)?.scenarios
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry?.id !== 'string' || typeof entry.file !== 'string') continue
      const file = resolve(root, entry.file)
      if (relative(root, file).startsWith('..') || !file.startsWith(root + sep)) {
        loadIssues.push({ severity: 'error', code: 'path-escape', scenarioId: entry.id, path: 'manifest.scenarios', message: `Manifest file "${entry.file}" leaves the content directory` })
        continue
      }
      scenarios[entry.id] = readJson(file, entry.file, loadIssues, entry.id)
      fixtures[entry.id] = readJson(file.replace(/\.json$/, '.fixtures.json'), entry.file.replace(/\.json$/, '.fixtures.json'), loadIssues, entry.id)
    }
  }

  const scenarioDir = join(root, 'scenarios')
  const scenarioFilesOnDisk = existsSync(scenarioDir) ? readdirSync(scenarioDir).filter((f) => f.endsWith('.json') && !f.endsWith('.fixtures.json')) : []

  // Remediation is optional per case: only cases with a sidecar get review cards; the rest are "not yet authored".
  const remediationDir = join(root, 'remediation')
  const remediation: Record<string, unknown> = {}
  if (existsSync(remediationDir)) {
    for (const f of readdirSync(remediationDir).filter((f) => f.endsWith('.json')).sort()) {
      remediation[f.replace(/\.json$/, '')] = readJson(join(remediationDir, f), `remediation/${f}`, loadIssues)
    }
  }
  const knowledgePath = join(root, 'knowledge', 'library.json')
  const knowledge = existsSync(knowledgePath) || Object.keys(remediation).length ? readJson(knowledgePath, 'knowledge/library.json', loadIssues) : undefined
  const taxonomyHistory = readJson(join(root, 'taxonomy-history.json'), 'taxonomy-history.json', loadIssues)
  const blueprints = readDir(root, 'blueprints', loadIssues)
  const sprints = readDir(root, 'sprints', loadIssues)
  return { dir: root, manifest, lock, taxonomy, scenarios, fixtures, scenarioFilesOnDisk, knowledge, remediation, taxonomyHistory, blueprints, sprints, loadIssues }
}

/** Every JSON file in an optional content subdirectory, keyed by file stem. */
function readDir(root: string, name: string, issues: Issue[]): Record<string, unknown> {
  const dir = join(root, name)
  const out: Record<string, unknown> = {}
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) out[f.replace(/\.json$/, '')] = readJson(join(dir, f), `${name}/${f}`, issues)
  return out
}
