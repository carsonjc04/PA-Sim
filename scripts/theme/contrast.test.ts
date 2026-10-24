import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { contrast, tokensOf } from '../../src/theme/contrast'

// Read from disk: Vitest stubs CSS imports, even with ?raw.
const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')

// The measured pairs in docs/design-system.md §1. Text needs 4.5:1 (WCAG 1.4.3); control boundaries need 3:1 (1.4.11).
const TEXT: [string, string][] = [
  ['--ink', '--form'], ['--ink', '--carbon-wash'], ['--ink', '--alert-wash'],
  ['--label', '--form'], ['--label', '--bg'], ['--label', '--carbon-wash'], ['--label', '--alert-wash'],
  ['--stamp', '--form'], ['--stamp', '--carbon-wash'],
  ['--on-stamp', '--stamp'], ['--on-stamp', '--stamp-hover'],
  ['--alert', '--form'], ['--alert', '--alert-wash'],
  ['--carbon', '--form'], ['--form', '--carbon'],
]
const UI: [string, string][] = [['--grid-strong', '--form'], ['--focus', '--form'], ['--focus', '--bg']]
const COLORS = ['--bg', '--form', '--grid', '--grid-strong', '--ink', '--label', '--stamp', '--stamp-hover', '--on-stamp', '--alert', '--alert-wash', '--carbon', '--carbon-wash', '--focus']

const themes = {
  light: tokensOf(css, ':root'),
  dark: tokensOf(css, ':root[data-theme=dark]'),
}

describe.each(Object.keys(themes) as (keyof typeof themes)[])('%s theme meets WCAG AA', (name) => {
  const t = themes[name]
  const resolve = (k: string) => {
    const v = t[k]
    expect(v, `${name} ${k} is defined`).toMatch(/^#[0-9a-f]{3,6}$/i)
    return v
  }
  it.each(TEXT)('text %s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(resolve(fg), resolve(bg))).toBeGreaterThanOrEqual(4.5)
  })
  it.each(UI)('UI %s against %s is at least 3:1', (fg, bg) => {
    expect(contrast(resolve(fg), resolve(bg))).toBeGreaterThanOrEqual(3)
  })
  it('defines every color token in §1', () => {
    for (const k of COLORS) resolve(k)
  })
})

describe('component CSS', () => {
  const body = css.slice(css.indexOf('/* Base */'))
  it('uses no color literals outside the token blocks', () => {
    expect(body.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi)).toBeNull()
  })
  it('keeps the bans: no shadows, gradients, transforms or rounded corners', () => {
    expect(body).not.toMatch(/box-shadow|gradient\(|(?<!text-)transform:|border-radius:(?!0)/)
  })
})
