import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

export interface Migration {
  version: number
  name: string
  sql: string
  checksum: string
}

const DEFAULT_DIR = fileURLToPath(new URL('./migrations', import.meta.url))
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/
// Arbitrary constant shared by every runner so concurrent deploys serialize.
const LOCK_KEY = 482_190_331

export function loadMigrations(dir = DEFAULT_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = FILE_PATTERN.exec(file)
      if (!match) throw new Error(`Migration file name must look like 0001_name.sql: ${file}`)
      const sql = readFileSync(join(dir, file), 'utf8')
      return {
        version: Number(match[1]),
        name: match[2],
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      }
    })
    .sort((a, b) => a.version - b.version)

  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 0001 upward without gaps; found ${m.version}`)
  })
  return migrations
}

/** Applies pending migrations in order, each in its own transaction. Returns the versions applied. */
export async function migrate(pool: pg.Pool, migrations = loadMigrations()): Promise<number[]> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)

    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )
    for (const row of rows) {
      const known = migrations.find((m) => m.version === row.version)
      if (!known) throw new Error(`Database has migration ${row.version} (${row.name}) that this build does not know`)
      if (known.checksum !== row.checksum) {
        throw new Error(`Migration ${row.version} (${row.name}) was edited after it was applied; add a new migration instead`)
      }
    }

    const applied: number[] = []
    for (const migration of migrations.filter((m) => !rows.some((r) => r.version === m.version))) {
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`)
      }
      applied.push(migration.version)
    }
    return applied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined)
    client.release()
  }
}
