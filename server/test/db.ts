import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { createPool, setPool } from '../db/pool'
import { migrate } from '../db/migrate'

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://clinicsim:clinicsim@127.0.0.1:5442/clinicsim_test'

export interface TestDatabase {
  pool: pg.Pool
  schema: string
  reset(): Promise<void>
  close(): Promise<void>
}

/** A private schema per test file, migrated from scratch, so files run in parallel without sharing rows. */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const schema = `t_${randomUUID().replace(/-/g, '')}`
  const admin = createPool(TEST_DATABASE_URL, { max: 1 })
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
  } catch (error) {
    await admin.end()
    throw new Error(
      `Cannot reach the test database at ${TEST_DATABASE_URL}. Start it with "npm run db:up". (${(error as Error).message})`,
    )
  }
  await admin.end()

  const pool = createPool(TEST_DATABASE_URL, { max: 5, options: `-c search_path=${schema}` })
  if (options.migrate !== false) await migrate(pool)
  setPool(pool)

  return {
    pool,
    schema,
    async reset() {
      await pool.query(
        'TRUNCATE users, content_versions, grading_versions, attempts, attempt_events, idempotency_keys, attempt_results, ' +
          'scheduler_params, review_cards, remediation_evidence, evidence_cards, remediation_derivations, review_sessions, review_events, learning_events, attempt_annotations, attempt_notes CASCADE',
      )
    },
    async close() {
      setPool(null)
      await pool.query(`DROP SCHEMA ${schema} CASCADE`)
      await pool.end()
    },
  }
}
