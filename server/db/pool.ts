import pg from 'pg'
import { env } from '../config/env'
import { ApiError } from '../http/errors'

export type Queryable = pg.Pool | pg.PoolClient

let shared: pg.Pool | null = null

export function createPool(connectionString: string, options: Partial<pg.PoolConfig> = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    max: 10,
    ...options,
  })
}

export function getPool(): pg.Pool {
  if (shared) return shared
  if (!env.DATABASE_URL) {
    throw new ApiError('Practice history is unavailable: the server has no database configured.', 503, 'database_unavailable')
  }
  if (!shared) shared = createPool(env.DATABASE_URL)
  return shared
}

/** Test seam. */
export function setPool(pool: pg.Pool | null): void {
  shared = pool
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
