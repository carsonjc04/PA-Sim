// Imported first by server/index.ts. It runs synchronously, so an invalid package stops the
// process before the app, the database or the listener are even loaded.
import { DEFAULT_CONTENT_DIR } from './loader'
import { ContentPackageError, loadContent } from './package'

const production = process.env.NODE_ENV === 'production'
const dir = !production && process.env.CONTENT_DIR ? process.env.CONTENT_DIR : DEFAULT_CONTENT_DIR

try {
  const pkg = loadContent(dir, { strict: production })
  console.log(`[server] content package ${pkg.manifest.manifestVersion} valid: ${pkg.scenarios.length} scenarios`)
  for (const w of pkg.warnings.filter((i) => i.code === 'review-overdue')) console.warn(`[server] content warning: ${w.scenarioId}: ${w.message}`)
} catch (error) {
  console.error(error instanceof ContentPackageError ? `[server] refusing to start. ${error.message}` : error)
  process.exit(1)
}
