import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { useIdentity } from './helpers'

// One guided encounter per case in a real browser, then its review plan and Today's review.

type Def = { phases: { id: string; label: string; actions: { id: string }[] }[]; diagnoses: { id: string }[]; planOptions: { id: string }[] }
type Prompt = { front: string; answer: string }

/** Presses Tab until the focused element matches. */
async function tabTo(page: Page, matches: (el: { text: string; cls: string }) => boolean, max = 200) {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab')
    const el = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null
      return { text: a?.textContent?.trim() ?? '', cls: a?.className ?? '' }
    })
    if (matches(el)) return
  }
  throw new Error('Could not reach the target with Tab')
}

async function chooseByKeyboard(page: Page, index: number) {
  await page.keyboard.press('Home')
  for (let i = 0; i < index; i += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
}

for (const scenarioId of ['asthma', 'chest-pressure', 'dysuria', 'metabolic']) {
  test(`${scenarioId}: review content appears after the debrief`, async ({ page }) => {
    const def = JSON.parse(readFileSync(`content/scenarios/${scenarioId}.json`, 'utf8')) as Def
    const sel = JSON.parse(readFileSync(`content/scenarios/${scenarioId}.fixtures.json`, 'utf8')).fixtures.find((f: { kind: string }) => f.kind === 'wrong-path').selections as Record<string, string[]>
    const prompts = (JSON.parse(readFileSync(`content/remediation/${scenarioId}.json`, 'utf8')).prompts as Prompt[])

    await useIdentity(page)
    await page.goto(`/encounter/${scenarioId}`)
    await page.getByRole('heading', { level: 1 }).waitFor()
    for (const phase of def.phases) {
      const ids = phase.id === 'diagnosis' ? def.diagnoses.map((d) => d.id) : phase.id === 'treatment' ? def.planOptions.map((p) => p.id) : phase.actions.map((a) => a.id)
      await expect(page.getByRole('heading', { level: 2, name: new RegExp(`^${phase.label}`) })).toBeVisible()
      if (sel[phase.id].length) {
        await tabTo(page, (el) => el.cls.includes('option-choose'))
        for (const id of sel[phase.id]) await chooseByKeyboard(page, ids.indexOf(id))
      }
      const last = phase.id === 'treatment'
      await page.getByRole('button', { name: last ? /^Review and submit/ : /^Lock phase and continue/ }).click()
      await page.getByRole('dialog').getByRole('button', { name: last ? 'Submit encounter' : 'Lock and continue' }).click()
    }
    await page.waitForURL(/\/results\//)

    const plan = page.locator('#review-plan')
    await expect(plan.getByText(/In today.s review/).first()).toBeVisible()
    await expect(plan.getByText(/are a draft/)).toBeVisible()
    await expect(plan).not.toContainText('Review not yet authored')

    await plan.getByRole('link', { name: /Today.s review/ }).click()
    await page.getByRole('button', { name: /^(Review (it|all \d+)|Quick \d+)$/ }).first().click()
    await expect(page.getByText('Draft questions, not yet clinically reviewed.')).toBeVisible()
    const front = (await page.locator('#review-prompt').textContent())?.trim()
    const prompt = prompts.find((p) => p.front === front)
    expect(prompt, `prompt shown: ${front}`).toBeTruthy()
    await page.getByRole('button', { name: 'Show answer' }).click()
    await expect(page.locator('.review-answer strong')).toHaveText(prompt!.answer)
  })
}
