import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../app'
import { devAuthProvider, setAuthProvider } from '../auth/context'
import { createTestDatabase, type TestDatabase } from '../test/db'
import { closeLocalServers, listenLocal } from '../test/http'
import { DEFAULT_CONTENT_DIR } from './loader'
import { loadContent, ContentPackageError } from './package'
import { contentVersionOf, currentContent, currentScenarios } from './versions'
import { contentPackage } from './scenarios'

const root = join(import.meta.dirname, '..', '..')

function brokenCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'content-broken-'))
  cpSync(DEFAULT_CONTENT_DIR, dir, { recursive: true })
  const file = join(dir, 'scenarios', 'asthma.json')
  const s = JSON.parse(readFileSync(file, 'utf8'))
  s.correctPrimary = 'does-not-exist'
  writeFileSync(file, JSON.stringify(s))
  return dir
}

describe('an invalid content package cannot ship', () => {
  it('loadContent throws with every error listed', () => {
    expect(() => loadContent(brokenCopy())).toThrow(ContentPackageError)
    expect(() => loadContent(brokenCopy())).toThrow(/correctPrimary/)
  })

  it('the server process exits non-zero before listening', () => {
    const run = spawnSync('npx', ['tsx', 'server/index.ts'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'development', CONTENT_DIR: brokenCopy(), PORT: '8791', DATABASE_URL: '' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('refusing to start')
    expect(run.stdout).not.toContain('listening on port')
  })

  it('production ignores CONTENT_DIR, so the override cannot be used to bypass the shipped package', () => {
    const run = spawnSync('npx', ['tsx', '-e', "import('./server/content/scenarios').then(m => console.log('N=' + m.scenarios.length))"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production', AUTH_PROVIDER: 'none', CONTENT_DIR: brokenCopy(), PORT: '8791' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(run.stdout).toContain('N=5')
  })

  it('the build gate (content:validate --strict) fails with a non-zero exit', () => {
    const run = spawnSync('npx', ['tsx', 'scripts/content/validate.ts', '--strict', '--dir', brokenCopy()], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('INVALID')
  })

  it('the build gate passes on the shipped package, and treats an unlocked version as an error', () => {
    const ok = spawnSync('npx', ['tsx', 'scripts/content/validate.ts', '--strict'], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    expect(ok.status).toBe(0)
    const dir = mkdtempSync(join(tmpdir(), 'content-unlocked-'))
    cpSync(DEFAULT_CONTENT_DIR, dir, { recursive: true })
    writeFileSync(join(dir, 'lock.json'), JSON.stringify({ lockVersion: 1, releases: [] }))
    const strict = spawnSync('npx', ['tsx', 'scripts/content/validate.ts', '--strict', '--dir', dir], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    expect(strict.status).toBe(1)
    expect(strict.stdout).toContain('lock-missing')
  })

  it('the build script runs the content gate before compiling', () => {
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>
    expect(scripts.build.startsWith('npm run content:check')).toBe(true)
    expect(scripts['content:check']).toContain('--strict')
  })
})

describe('historical attempts keep their exact content and grading version', () => {
  let db: TestDatabase
  let app: Server
  beforeAll(async () => {
    db = await createTestDatabase()
    app = await listenLocal(createApp())
  })
  afterAll(async () => {
    await closeLocalServers()
    await db.close()
  })
  beforeEach(async () => {
    await db.reset()
    setAuthProvider(devAuthProvider)
  })

  const as = (user = 'alice') => ({
    start: (scenarioId: string) => request(app).post('/api/attempts').set('X-Dev-User', user).send({ scenarioId }),
    get: (id: string) => request(app).get(`/api/attempts/${id}`).set('X-Dev-User', user),
  })

  it('records the semantic version, manifest version and exact hash with each snapshot', async () => {
    const res = await as().start('asthma')
    const pinned = res.body.attempt.contentVersionId as string
    const { rows } = await db.pool.query('SELECT content_hash, content_semver, manifest_version, lifecycle_status, definition FROM content_versions WHERE id = $1', [pinned])
    const expected = contentVersionOf(contentPackage().scenarios.find((s) => s.id === 'asthma')!)
    expect(pinned).toBe(expected.id)
    expect(rows[0]).toMatchObject({ content_hash: expected.hash, content_semver: '1.1.0', manifest_version: contentPackage().manifest.manifestVersion, lifecycle_status: 'draft' })
    expect(rows[0].definition.lifecycle.contentVersion).toBe('1.1.0')
  })

  it('an edited case gets a new snapshot; the old attempt still shows and grades the old one', async () => {
    const first = await as().start('asthma')
    const oldId = first.body.attempt.contentVersionId as string
    const edited = structuredClone(contentPackage().scenarios.find((s) => s.id === 'asthma')!)
    edited.opening = 'An edited opening line.'
    edited.lifecycle.contentVersion = '1.0.2'
    const newer = contentVersionOf(edited)
    expect(newer.id).not.toBe(oldId)
    expect(newer.semver).toBe('1.0.2')

    await db.pool.query(
      `INSERT INTO content_versions (id, scenario_id, schema_version, content_hash, definition, content_semver, manifest_version, lifecycle_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newer.id, 'asthma', '2.0', newer.hash, JSON.stringify(edited), newer.semver, newer.manifestVersion, 'draft'],
    )
    const again = await as().get(first.body.attempt.id)
    expect(again.body.contentVersionId).toBe(oldId)
    expect(again.body.scenario.opening).toBe(contentPackage().scenarios.find((s) => s.id === 'asthma')!.opening)
  })

  it('a pre-package (schema 1.0) snapshot still loads, renders and grades', async () => {
    const legacy = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'chest-pressure.v1.json'), 'utf8'))
    await db.pool.query(`INSERT INTO content_versions (id, scenario_id, schema_version, content_hash, definition) VALUES ('chest-pressure@legacy000001','chest-pressure','1.0','legacy',$1)`, [JSON.stringify(legacy)])
    const user = await db.pool.query(`INSERT INTO users (id, auth_provider, external_subject, display_name) VALUES (gen_random_uuid(),'dev','alice','alice') RETURNING id`)
    const attempt = await db.pool.query(
      `INSERT INTO attempts (id, user_id, scenario_id, content_version_id, status, current_phase) VALUES (gen_random_uuid(), $1, 'chest-pressure', 'chest-pressure@legacy000001', 'active', 'history') RETURNING id`,
      [user.rows[0].id],
    )
    const id = attempt.rows[0].id as string
    const detail = await as().get(id)
    expect(detail.status).toBe(200)
    expect(detail.body.contentVersionId).toBe('chest-pressure@legacy000001')
    expect(detail.body.scenario.reviewStatus).toBe('requires-clinician-review')
    // The old ID "ems" still works on the old snapshot: renamed IDs only apply to new attempts.
    const ids = detail.body.scenario.phases.find((p: { id: string }) => p.id === 'diagnostics').actions.map((a: { id: string }) => a.id)
    expect(ids).toContain('ems')
  })

  it('records the grading version on every result', async () => {
    const start = await as().start('asthma')
    const id = start.body.attempt.id as string
    for (const [phase, tool, action] of [['history', 'record_history_topics', 'speak'], ['exam', 'request_physical_exam', 'vitals'], ['diagnostics', 'order_diagnostic_test', 'reassess']] as const) {
      await request(app).post(`/api/attempts/${id}/events`).set('X-Dev-User', 'alice').set('Idempotency-Key', `key-act-${phase}`).send({ type: 'action', tool, actionIds: [action] })
      await request(app).post(`/api/attempts/${id}/events`).set('X-Dev-User', 'alice').set('Idempotency-Key', `key-lock-${phase}`).send({ type: 'lock_phase', phase })
    }
    const dx = await request(app).post(`/api/attempts/${id}/events`).set('X-Dev-User', 'alice').set('Idempotency-Key', 'dx-pick-1').send({ type: 'action', tool: 'propose_diagnosis', actionIds: ['asthma-exac'], confirmed: true })
    expect(dx.status, JSON.stringify(dx.body)).toBe(200)
    await request(app).post(`/api/attempts/${id}/events`).set('X-Dev-User', 'alice').set('Idempotency-Key', 'dx-lock-1').send({ type: 'lock_phase', phase: 'diagnosis' })
    const submitted = await request(app).post(`/api/attempts/${id}/submit`).set('X-Dev-User', 'alice')
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
    const { rows } = await db.pool.query('SELECT grading_version_id, content_version_id FROM attempt_results WHERE attempt_id = $1', [id])
    expect(rows[0].grading_version_id).toBe(contentPackage().manifest.gradingVersion)
    expect(rows[0].content_version_id).toBe(submitted.body.contentVersionId)
  })
})

describe('retired cases', () => {
  it('are hidden from the catalogue and refused for new attempts (410), but stay known', async () => {
    const pkg = contentPackage()
    const retired = pkg.scenarios.find((s) => s.id === 'metabolic')!
    const before = { status: retired.lifecycle.status, published: pkg.manifest.scenarios.find((e) => e.id === 'metabolic')!.published }
    try {
      retired.lifecycle.status = 'retired'
      pkg.manifest.scenarios.find((e) => e.id === 'metabolic')!.published = false
      expect(currentScenarios().map((s) => s.id)).not.toContain('metabolic')
      expect(() => currentContent('metabolic')).toThrow(/retired/)
      expect(() => currentContent('nope')).toThrow(/not found/)
      expect(pkg.scenarios.some((s) => s.id === 'metabolic')).toBe(true)
    } finally {
      retired.lifecycle.status = before.status
      pkg.manifest.scenarios.find((e) => e.id === 'metabolic')!.published = before.published
    }
  })
})
