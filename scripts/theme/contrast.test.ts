import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { contrast, tokensOf } from '../../src/theme/contrast'

// Read from disk: Vitest stubs CSS imports, even with ?raw.
const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')

// Text pairs need 4.5:1 (WCAG 1.4.3). Focus rings and control boundaries need 3:1 (1.4.11).
const TEXT: [string, string][] = [
  ['--navy', '--bg'], ['--navy', '--surface'], ['--navy', '--surface-2'], ['--navy', '--surface-3'], ['--navy', '--accent-soft'],
  ['--text-2', '--surface'], ['--text-2', '--surface-2'], ['--text-2', '--bg'],
  ['--muted', '--bg'], ['--muted', '--surface'], ['--muted', '--surface-2'], ['--muted', '--accent-soft'], ['--muted', '--warning-soft'],
  ['--teal', '--surface'], ['--teal', '--bg'], ['--teal', '--surface-2'], ['--teal', '--accent-soft'],
  ['--teal-dark', '--accent-soft'], ['--teal-dark', '--surface'],
  ['--on-accent', '--teal'], ['--on-accent', '--teal-dark'], ['--on-accent', '--red'], ['--on-accent', '--red-hover'],
  ['--amber', '--warning-soft'], ['--amber', '--surface'], ['--warning-text', '--warning-soft'], ['--warning-text', '--surface'],
  ['--red', '--surface'], ['--red', '--danger-soft'], ['--danger-text', '--danger-soft'], ['--danger-text', '--danger-soft-2'],
  ['--patient-text', '--patient-soft'], ['--patient-text', '--surface'], ['--info-text', '--info-soft'],
]
const UI: [string, string][] = [
  ['--focus', '--bg'], ['--focus', '--surface'], ['--focus', '--surface-2'],
  ['--line-strong', '--surface'], ['--line-strong', '--surface-2'], ['--accent-line', '--surface'],
]
const HOME_TEXT: [string, string][] = [
  ['--home-ink', '--home-paper'], ['--home-ink', '--home-paper-2'], ['--home-muted', '--home-paper'], ['--home-burgundy', '--home-paper'],
]

const themes = {
  light: tokensOf(css, ':root'),
  dark: tokensOf(css, ':root[data-theme=dark]'),
}
const home = { light: tokensOf(css, '.home'), dark: tokensOf(css, ':root[data-theme=dark] .home') }

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
  it.each(HOME_TEXT)('home text %s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(home[name][fg], home[name][bg])).toBeGreaterThanOrEqual(4.5)
  })
  it('keeps the banner text readable on the burgundy banner', () => {
    expect(contrast('#f7ede0', home[name]['--home-burgundy-bg'])).toBeGreaterThanOrEqual(4.5)
  })
  it('declares the same tokens as the light theme', () => {
    const lightKeys = Object.keys(themes.light).filter((k) => k !== '--paper')
    for (const k of lightKeys) expect(t[k], `${name} ${k}`).toBeDefined()
  })
})
