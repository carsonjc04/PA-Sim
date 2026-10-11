import { expect, test, type Page } from '@playwright/test'
import { axeViolations, horizontalOverflow, playFixture, useIdentity, WIDTHS } from './helpers'

// Themes and reading size: no axe (WCAG 2.2 AA) violations, including color contrast, and no horizontal
// overflow at any width, in light and dark, at 100% and 150% text.
const setDisplay = (page: Page, theme: 'light' | 'dark', reading: '100' | '150') =>
  page.addInitScript((v) => window.localStorage.setItem('clinicsim-display-v1', JSON.stringify(v)), { theme, reading })

for (const theme of ['light', 'dark'] as const) {
  for (const reading of ['100', '150'] as const) {
    test(`encounter and debrief in ${theme} at ${reading}%`, async ({ page, request }) => {
      const user = await useIdentity(page)
      await setDisplay(page, theme, reading)
      const debrief = await playFixture(request, user, 'chest-pressure', 'critical-safety-miss')
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w.width, height: w.height })
        for (const path of ['/encounter/respiratory', `/results/${debrief}`, '/']) {
          await page.goto(path)
          await page.getByRole('heading', { level: 1 }).first().waitFor()
          await expect.soft(page.locator('html')).toHaveAttribute('data-theme', theme)
          expect.soft(await horizontalOverflow(page), `${path} overflow at ${w.name}`).toBe(0)
          expect.soft(await axeViolations(page), `${path} axe at ${w.name}`).toEqual([])
        }
      }
    })
  }
}
