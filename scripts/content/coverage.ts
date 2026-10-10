// Usage: tsx scripts/content/coverage.ts [--check]
// Writes docs/content-coverage.md and docs/content-status.md; --check fails if they are stale.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadContent } from '../../server/content/package'
import { coverageMarkdown, statusMarkdown } from '../../server/content/report'

const check = process.argv.includes('--check')
const pkg = loadContent()
const outputs: [string, string][] = [
  ['docs/content-coverage.md', coverageMarkdown(pkg)],
  ['docs/content-status.md', statusMarkdown(pkg)],
]

let stale = false
for (const [path, body] of outputs) {
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== body) {
      console.error(`[content] ${path} is out of date. Run npm run content:coverage and commit the result.`)
      stale = true
    }
  } else {
    writeFileSync(path, body)
    console.log(`[content] wrote ${path}`)
  }
}
if (stale) process.exit(1)
if (check) console.log('[content] reports are up to date')
