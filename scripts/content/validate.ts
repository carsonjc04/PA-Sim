// Usage: tsx scripts/content/validate.ts [--strict] [--json] [--dir <path>]
import { formatIssues, validatePackage } from '../../server/content/validate'
import { DEFAULT_CONTENT_DIR, readPackage } from '../../server/content/loader'

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const json = args.includes('--json')
const dirIndex = args.indexOf('--dir')
const dir = dirIndex >= 0 ? args[dirIndex + 1] : DEFAULT_CONTENT_DIR

const result = validatePackage(readPackage(dir), { strict })
if (json) {
  console.log(JSON.stringify({ ok: result.errors.length === 0, errors: result.errors, warnings: result.warnings }, null, 2))
} else {
  if (result.issues.length) console.log(formatIssues(result.issues))
  const n = result.package?.scenarios.length
  console.log(
    result.errors.length
      ? `\n[content] INVALID: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`
      : `[content] valid: ${n} scenario(s), ${result.warnings.length} warning(s)${strict ? ' (strict)' : ''}`,
  )
}
process.exit(result.errors.length ? 1 : 0)
