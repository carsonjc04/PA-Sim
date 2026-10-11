// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { axeViolations } from '../../test/axe'
import { DISPLAY_KEY, parseDisplay } from './displaySettings'
import { SettingsButton } from './SettingsDialog'

beforeAll(() => {
  // jsdom implements <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open') }
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  for (const a of ['data-theme', 'data-reading', 'data-motion']) document.documentElement.removeAttribute(a)
})

describe('display settings', () => {
  it('applies theme, reading size and motion to <html> and remembers them', async () => {
    render(<SettingsButton />)
    await userEvent.click(screen.getByRole('button', { name: 'Display' }))
    const dialog = screen.getByRole('dialog', { name: 'Display settings' })
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Largest (150%)' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Reduce motion' }))
    const root = document.documentElement
    expect(root).toHaveAttribute('data-theme', 'dark')
    expect(root).toHaveAttribute('data-reading', '150')
    expect(root).toHaveAttribute('data-motion', 'reduce')
    expect(parseDisplay(localStorage.getItem(DISPLAY_KEY))).toMatchObject({ theme: 'dark', reading: '150', motion: 'reduce' })
    expect(await axeViolations(dialog)).toEqual([])
  })

  it('falls back to defaults for missing or tampered storage', () => {
    expect(parseDisplay(null)).toEqual({ theme: 'system', reading: '100', motion: 'system', downtime: false, shortcuts: true })
    expect(parseDisplay('{"theme":"neon","reading":"300","downtime":"yes"}')).toMatchObject({ theme: 'system', reading: '100', downtime: false })
    expect(parseDisplay('not json').theme).toBe('system')
  })
})
