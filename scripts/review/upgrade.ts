// Usage: tsx scripts/review/upgrade.ts
// Replays every review card stamped with an older scheduler version or parameters under the
// current one. Cards are also upgraded lazily on each user's next review request; this script
// does it eagerly after a ts-fsrs upgrade or a parameter change. Safe to run more than once.
import 'dotenv/config'
import { env } from '../../server/config/env'
import { createPool, setPool, withTransaction } from '../../server/db/pool'
import { now } from '../../server/lib/clock'
import { getScheduler } from '../../server/review/scheduler'
import { upgradeStaleCards } from '../../server/review/service'

if (!env.DATABASE_URL) {
  console.error('[review] DATABASE_URL is not set')
  process.exit(1)
}
const pool = createPool(env.DATABASE_URL)
setPool(pool)
const scheduler = getScheduler()
const upgraded = await withTransaction(pool, (q) => upgradeStaleCards(q, scheduler, now()))
console.log(`[review] ${upgraded} card(s) replayed under ${scheduler.algorithmVersion} (params ${scheduler.paramsId})`)
await pool.end()
