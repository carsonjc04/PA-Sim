import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { axeViolations, horizontalOverflow, useIdentity } from './helpers'

// The guided encounter in a real browser with AI voice disabled on the server.

type Def = { phases: { id: string; label: string; actions: { id: string }[] }[]; diagnoses: { id: string }[]; planOptions: { id: string }[] }
const def = JSON.parse(readFileSync('content/scenarios/respiratory.json', 'utf8')) as Def
const happy = JSON.parse(readFileSync('content/scenarios/respiratory.fixtures.json', 'utf8')).fixtures.find((f: { kind: string }) => f.kind === 'happy-path').selections as Record<string, string[]>

/** Presses Tab (never the mouse) until the focused element matches. */
async function tabTo(page: Page, matches: (el: { tag: string; text: string; cls: string; role: string | null }) => boolean, max = 120) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab')
    const el = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null
      return { tag: a?.tagName ?? '', text: a?.textContent?.trim() ?? '', cls: a?.className ?? '', role: a?.getAttribute('role') ?? null }
    })
    if (matches(el)) return
  }
  throw new Error(`Could not reach the target with Tab; focus is on: ${await page.evaluate(() => (document.activeElement as HTMLElement | null)?.outerHTML.slice(0, 160))}`)
}
const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')

/** Moves focus within the option list with arrow keys to the row at `index`, then presses Enter. */
async function chooseByKeyboard(page: Page, index: number) {
  await page.keyboard.press('Home')
  for (let i = 0; i < index; i += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
}

test.describe('keyboard-only guided encounter', () => {
  test('completes the whole case at 360px with no mouse, microphone or AI', async ({ page }) => {
    await useIdentity(page)
    await page.setViewportSize({ width: 360, height: 780 })
    await page.goto('/encounter/respiratory')
    await page.getByRole('heading', { level: 1 }).waitFor()

    for (const phase of def.phases) {
      const picks = phase.id === 'diagnosis' ? happy.diagnosis : phase.id === 'treatment' ? happy.treatment : happy[phase.id]
      const ids = phase.id === 'diagnosis' ? def.diagnoses.map((d) => d.id) : phase.id === 'treatment' ? def.planOptions.map((p) => p.id) : phase.actions.map((a) => a.id)
      await expect(page.getByRole('heading', { level: 2, name: new RegExp(`^${phase.label}`) })).toBeVisible()
      await tabTo(page, (el) => el.cls.includes('option-choose'))
      for (const id of picks) {
        await chooseByKeyboard(page, ids.indexOf(id))
        if (phase.id !== 'diagnosis' && phase.id !== 'treatment') await expect(page.locator('.option-row.is-selected')).toHaveCount(picks.indexOf(id) + 1)
      }
      const last = phase.id === 'treatment'
      await tabTo(page, (el) => el.text.startsWith(last ? 'Review and submit' : 'Lock phase and continue'))
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await tabTo(page, (el) => el.text === (last ? 'Submit encounter' : 'Lock and continue'), 6)
      await page.keyboard.press('Enter')
      if (!last) await expect.poll(() => focusedText(page)).toMatch(/./) // focus lands on the next phase heading
    }
    await page.waitForURL(/\/results\//)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('closes the confirmation dialog with Escape and returns focus to its trigger', async ({ page }) => {
    await useIdentity(page)
    await page.goto('/encounter/respiratory')
    await page.getByRole('heading', { level: 1 }).waitFor()
    await tabTo(page, (el) => el.text.startsWith('Lock phase and continue'))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    expect(await focusedText(page)).toMatch(/^Lock phase and continue/)
  })
})

test('microphone denial explains the problem and guided mode still works', async ({ page }) => {
  await useIdentity(page)
  // Pretend voice is configured so the panel offers Connect; the browser then refuses the microphone.
  await page.route('**/api/ai/status', (route) => route.fulfill({ json: { aiEnabled: true, setupHint: null, maxSessionMinutes: 20, estimatedVoiceRatePerMinuteUsd: 0.05, storeTranscripts: false } }))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) } })
  })
  await page.goto('/encounter/respiratory')
  await page.getByRole('heading', { level: 1 }).waitFor()
  await page.getByText('Voice conversation (optional)').click()
  await page.getByRole('button', { name: /Connect voice/ }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Microphone access was blocked' })).toBeVisible()
  await expect(page.getByText(/continue in guided mode/)).toBeVisible()
  await page.locator('.option-choose').first().click()
  await expect(page.locator('.option-row.is-selected')).toHaveCount(1)
})

test('offline: choices pause, notes stay on the device, then sync', async ({ page, context }) => {
  await useIdentity(page)
  await page.goto('/encounter/respiratory')
  await page.getByRole('heading', { level: 1 }).waitFor()
  await expect(page.getByLabel('Notes for this attempt')).toBeEnabled()
  await context.setOffline(true)
  await expect(page.getByRole('status').filter({ hasText: 'Offline.' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Lock phase and continue/ })).toBeDisabled()
  await page.getByLabel('Notes for this attempt').fill('Consider strep; check Centor')
  await expect(page.getByText(/Offline: saved on this device/)).toBeVisible()
  expect(await axeViolations(page)).toEqual([])
  await context.setOffline(false)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
  await page.reload()
  await expect(page.getByLabel('Notes for this attempt')).toHaveValue('Consider strep; check Centor')
})

for (const theme of ['light', 'dark'] as const) {
  test(`downtime mode at 360px and 150% text in ${theme}: no overflow, no axe violations`, async ({ page }) => {
    await useIdentity(page)
    await page.addInitScript((t) => window.localStorage.setItem('clinicsim-display-v1', JSON.stringify({ theme: t, reading: '150', downtime: true })), theme)
    for (const width of [360, 390, 768]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/encounter/respiratory')
      await page.getByRole('heading', { level: 1 }).waitFor()
      await page.locator('.option-choose').first().click()
      await page.locator('.entry-text').nth(2).waitFor()
      expect(await horizontalOverflow(page), `overflow at ${width}`).toBe(0)
      expect(await axeViolations(page), `axe at ${width}`).toEqual([])
      // The primary action stays inside the viewport, within thumb reach.
      const box = await page.getByRole('button', { name: /Lock phase and continue/ }).boundingBox()
      expect(box && box.y + box.height <= 800).toBe(true)
    }
  })
}

test('reduced motion is honored', async ({ page }) => {
  await useIdentity(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/encounter/respiratory')
  await page.getByRole('heading', { level: 1 }).waitFor()
  const durations = await page.evaluate(() => [...document.querySelectorAll('button, a')].map((el) => getComputedStyle(el).transitionDuration))
  expect(durations.every((d) => d.split(',').every((x) => parseFloat(x) === 0))).toBe(true)
})
