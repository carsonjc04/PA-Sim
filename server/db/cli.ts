import 'dotenv/config'
import { getPool } from './pool'
import { migrate } from './migrate'

const pool = getPool()
try {
  const applied = await migrate(pool)
  console.log(applied.length ? `[db] applied migrations: ${applied.join(', ')}` : '[db] schema is up to date')
} finally {
  await pool.end()
}
