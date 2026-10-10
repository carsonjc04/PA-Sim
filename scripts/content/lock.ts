// Usage: tsx scripts/content/lock.ts
// Records the fingerprint of every version not yet in content/lock.json. Existing entries are never rewritten.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONTENT_DIR } from '../../server/content/loader'
import { loadContent } from '../../server/content/package'
import { lockFor } from '../../server/content/report'

const pkg = loadContent()
const next = lockFor(pkg, pkg.lock)
const added = next.releases.length - pkg.lock.releases.length
writeFileSync(join(DEFAULT_CONTENT_DIR, 'lock.json'), `${JSON.stringify(next, null, 2)}\n`)
console.log(`[content] lock updated: ${added} new release(s)`)
