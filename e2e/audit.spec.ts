import { mkdirSync, writeFileSync } from 'node:fs'
import { test, type Page } from '@playwright/test'
import { axeViolations, horizontalOverflow, playFixture, useIdentity, WIDTHS } from './helpers'

// Baseline UX audit: every encounter/debrief state reachable with AI voice disabled, at four widths.
// Writes screenshots to $AUDIT_OUT (default test-results/ux-audit/) and measurements to test-results/ux-audit.json.
// It records; it does not assert. The baseline (before the redesign) is summarized in docs/ux-audit.md.

interface Row { state: string; width: string; overflowPx: number; violations: { id: string; impact: string | null | undefined; nodes: number; help: string }[] }
const rows: Row[] = []
const OUT = process.env.AUDIT_OUT ?? 'test-results/ux-audit'
mkdirSync(OUT, { recursive: true })

async function capture(page: Page, state: string, width: string) {
  await page.waitForTimeout(400) // let layout settle; never wait for network idle (the loading state holds a request open)
  rows.push({ state, width, overflowPx: await horizontalOverflow(page), violations: await axeViolations(page) })
  await page.screenshot({ path: `${OUT}/${state}-${width}.png`, fullPage: false })
}

for (const w of WIDTHS) {
  test(`audit at ${w.name}`, async ({ page, context, request }) => {
    await page.setViewportSize({ width: w.width, height: w.height })
    const user = await useIdentity(page)

    // Loading: hold the start request so the loading state is visible.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    let holding = true
    await page.route('**/api/attempts', async (route) => {
      if (holding && route.request().method() === 'POST') await held
      await route.continue().catch(() => {})
    })
    await page.goto('/encounter/respiratory')
    await page.getByText(/Loading encounter/).waitFor()
    await capture(page, 'loading', w.name)
    holding = false
    release()

    // Fresh encounter (voice unconfigured, because the e2e server has no API key).
    await page.getByRole('heading', { level: 1 }).waitFor()
    await capture(page, 'fresh-voice-unconfigured', w.name)

    // After a reveal.
    await page.locator('.option-choose').first().click()
    await page.locator('.entry-text').nth(2).waitFor()
    await capture(page, 'finding-revealed', w.name)

    // Resumed.
    await page.reload()
    await page.locator('.entry-text').nth(2).waitFor()
    await capture(page, 'resumed', w.name)

    // Phase-lock dialog.
    await page.getByRole('button', { name: /Lock phase and continue/ }).click()
    await page.getByRole('dialog').waitFor()
    await capture(page, 'phase-lock-dialog', w.name)
    await page.keyboard.press('Escape')

    // Offline: the next action fails.
    await context.setOffline(true)
    await page.getByText(/Choices are paused/).first().waitFor()
    await capture(page, 'offline-action', w.name)
    await context.setOffline(false)

    // Downtime mode.
    await page.evaluate(() => localStorage.setItem('clinicsim-display-v1', JSON.stringify({ downtime: true })))
    await page.reload()
    await page.getByRole('heading', { level: 1 }).waitFor()
    await capture(page, 'downtime', w.name)
    await page.evaluate(() => localStorage.removeItem('clinicsim-display-v1'))

    // Debriefs: a passing attempt and a critical-safety failure.
    const passed = await playFixture(request, user, 'respiratory', 'happy-path')
    await page.goto(`/results/${passed}`)
    await page.getByRole('heading', { level: 1 }).waitFor()
    await capture(page, 'debrief-passed', w.name)
    const critical = await playFixture(request, user, 'chest-pressure', 'critical-safety-miss')
    await page.goto(`/results/${critical}`)
    await page.getByRole('heading', { level: 1 }).waitFor()
    await capture(page, 'debrief-critical', w.name)
  })
}

test.afterAll(() => {
  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/ux-audit.json', JSON.stringify(rows, null, 2))
})
