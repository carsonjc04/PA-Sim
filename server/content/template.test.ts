import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentFingerprint } from './hash'
import { DEFAULT_CONTENT_DIR, readPackage } from './loader'
import { validatePackage } from './validate'
import { safeParseScenario } from '../../src/domain/schema'

const template = JSON.parse(readFileSync(join(DEFAULT_CONTENT_DIR, 'template', 'scenario.template.json'), 'utf8'))

describe('case template', () => {
  it('is a schema-valid ScenarioDefinition', () => {
    expect(safeParseScenario(template).success).toBe(true)
  })

  it('passes the full validator when added to a package, so authors start from a working case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'content-template-'))
    cpSync(DEFAULT_CONTENT_DIR, dir, { recursive: true })
    mkdirSync(join(dir, 'scenarios'), { recursive: true })
    cpSync(join(dir, 'template', 'scenario.template.json'), join(dir, 'scenarios', 'template-example.json'))
    cpSync(join(dir, 'template', 'scenario.template.fixtures.json'), join(dir, 'scenarios', 'template-example.fixtures.json'))
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    manifest.scenarios.push({ id: 'template-example', file: 'scenarios/template-example.json', contentVersion: '0.1.0', status: 'draft', published: false })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    const result = validatePackage(readPackage(dir))
    expect(result.errors.filter((e) => e.scenarioId === 'template-example').map((e) => `${e.code}: ${e.message}`)).toEqual([])
    expect(result.errors.some((e) => e.code === 'lock-mismatch')).toBe(false)
    expect(contentFingerprint(result.package!.scenarios.find((s) => s.id === 'template-example')!)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is not part of the published manifest', () => {
    const manifest = JSON.parse(readFileSync(join(DEFAULT_CONTENT_DIR, 'manifest.json'), 'utf8'))
    expect(manifest.scenarios.some((s: { id: string }) => s.id === 'template-example')).toBe(false)
  })

  it('stays a draft with no reviews and no approval', () => {
    expect(template.lifecycle.status).toBe('draft')
    expect(template.lifecycle.reviews).toEqual([])
  })
})
