import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { loadMigrations, migrate } from './migrate'

let db: TestDatabase

beforeAll(async () => {
  db = await createTestDatabase({ migrate: false })
})
afterAll(() => db.close())

function migrationDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'clinicsim-migrations-'))
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

describe('migration runner', () => {
  it('applies every shipped migration once on a fresh database, then nothing', async () => {
    const shipped = loadMigrations()
    expect(await migrate(db.pool, shipped)).toEqual(shipped.map((m) => m.version))
    expect(await migrate(db.pool, shipped)).toEqual([])

    const { rows } = await db.pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version')
    expect(rows.map((r) => r.checksum)).toEqual(shipped.map((m) => m.checksum))
    const tables = await db.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [db.schema],
    )
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['attempts', 'attempt_events', 'attempt_results', 'content_versions', 'users']),
    )
  })

  it('refuses to start when an applied migration was edited', async () => {
    const edited = loadMigrations().map((m, i) => (i === 0 ? { ...m, checksum: 'tampered' } : m))
    await expect(migrate(db.pool, edited)).rejects.toThrow(/edited after it was applied/)
  })

  it('refuses a database that is ahead of this build', async () => {
    await expect(migrate(db.pool, [])).rejects.toThrow(/does not know/)
  })

  it('rolls back a failing migration and records nothing for it', async () => {
    const shipped = loadMigrations()
    const broken = [...shipped, { version: shipped.length + 1, name: 'broken', sql: 'CREATE TABLE ok_part (id int); SELECT nope;', checksum: 'x' }]
    await expect(migrate(db.pool, broken)).rejects.toThrow(/broken/)
    const { rows } = await db.pool.query(`SELECT to_regclass('ok_part') AS t`)
    expect(rows[0].t).toBeNull()
    const versions = await db.pool.query('SELECT max(version) AS v FROM schema_migrations')
    expect(versions.rows[0].v).toBe(shipped.length)
  })

  it('serializes concurrent runners so each migration is applied exactly once', async () => {
    const fresh = await createTestDatabase({ migrate: false })
    try {
      const results = await Promise.all([migrate(fresh.pool), migrate(fresh.pool), migrate(fresh.pool)])
      expect(results.flat().sort()).toEqual(loadMigrations().map((m) => m.version))
    } finally {
      await fresh.close()
    }
  })

  it('rejects misnamed files and numbering gaps', () => {
    expect(() => loadMigrations(migrationDir({ 'init.sql': 'SELECT 1' }))).toThrow(/0001_name/)
    expect(() => loadMigrations(migrationDir({ '0001_a.sql': 'SELECT 1', '0003_c.sql': 'SELECT 1' }))).toThrow(/without gaps/)
  })
})
