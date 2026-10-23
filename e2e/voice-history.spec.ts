import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { API, axeViolations, useIdentity } from './helpers'

// Voice history in a real browser. AI voice is disabled on the e2e server, so the questions the patient would
// have heard are recorded through the same attempt-event API the voice tool uses (as guided events).

type Action = { id: string; label: string; paText: string; effects?: { points: number }[]; unsafeReason?: string }
const def = JSON.parse(readFileSync('content/scenarios/chest-pressure.json', 'utf8')) as { opening: string; correctPrimary: string; phases: { id: string; actions: Action[] }[] }
const history = def.phases.find((p) => p.id === 'history')!.actions
const key = history.filter((a) => (a.effects ?? []).reduce((n, e) => n + e.points, 0) > 0 && !a.unsafeReason)
const shot = process.env.E2E_SHOTS

/** Every history question whose label or wording is anywhere on the page. */
const questionsOnPage = async (page: Page) => {
  const text = await page.locator('body').innerText()
  return history.filter((a) => text.includes(a.label) || text.includes(a.paText)).map((a) => a.id)
}

test('voice history gives nothing away, hints one question at a time, and the debrief has the full checklist', async ({ page, request }) => {
  const user = await useIdentity(page)
  let n = 0
  const post = (path: string, data?: object) => request.post(`${API}${path}`, { headers: { 'X-Dev-User': user, 'Idempotency-Key': `e2e-voice-${Date.now()}-${(n += 1)}` }, data })

  await page.goto('/encounter/chest-pressure')
  await page.getByRole('heading', { level: 1 }).waitFor()
  await expect(page.locator('.option-choose').first()).toBeVisible()
  await page.getByRole('button', { name: 'Voice, no list' }).click()
  await expect(page.locator('.option-choose')).toHaveCount(0)
  expect(await questionsOnPage(page)).toEqual([])
  await expect(page.getByText(def.opening)).toBeVisible()
  await expect(page.getByRole('heading', { name: /Voice is not set up|Voice is unavailable|Voice conversation/ })).toBeVisible()
  const hint = page.getByRole('button', { name: 'Show one suggested question' })
  await expect(hint).toBeVisible()
  if (shot) await page.screenshot({ path: `${shot}/1-voice-history.png`, fullPage: true })

  // Keyboard: focus the hint button and press it once per key question; focus never moves.
  await hint.focus()
  for (let i = 1; i <= key.length; i += 1) {
    await page.keyboard.press('Enter')
    await expect(page.getByRole('list', { name: 'Suggested questions' }).getByRole('listitem')).toHaveCount(i)
    await expect(page.getByText(`Hints used: ${i}`)).toBeVisible()
    expect(await questionsOnPage(page)).toEqual(key.slice(0, i).map((a) => a.id))
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain('Show one suggested question')
  }
  expect(await axeViolations(page)).toEqual([])
  if (shot) await page.screenshot({ path: `${shot}/2-hints.png`, fullPage: true })

  // Reload keeps voice mode: still no list.
  await page.reload()
  await page.getByRole('heading', { level: 1 }).waitFor()
  await expect(page.locator('.option-choose')).toHaveCount(0)

  // Ask two of the hinted questions, finish the case, submit.
  const id = ((await (await post('/api/attempts', { scenarioId: 'chest-pressure' })).json()) as { attempt: { id: string } }).attempt.id
  await post(`/api/attempts/${id}/events`, { type: 'action', tool: 'record_history_topics', actionIds: [key[0].id, key[1].id] })
  for (const phase of ['history', 'exam', 'diagnostics']) await post(`/api/attempts/${id}/events`, { type: 'lock_phase', phase })
  await post(`/api/attempts/${id}/events`, { type: 'action', tool: 'propose_diagnosis', actionIds: [def.correctPrimary], confirmed: true })
  await post(`/api/attempts/${id}/events`, { type: 'lock_phase', phase: 'diagnosis' })
  expect((await post(`/api/attempts/${id}/submit`)).ok()).toBe(true)

  await page.goto(`/results/${id}`)
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'History checklist: what did I ask?' }) })
  await expect(section).toContainText(`Hints used: ${key.length}.`)
  const rows = section.getByRole('listitem')
  await expect(rows).toHaveCount(key.length)
  for (const [i, a] of key.entries()) {
    await expect(rows.nth(i)).toContainText(a.label)
    await expect(rows.nth(i).locator('.checklist-state')).toHaveText(i < 2 ? /^Asked with hint · / : /^Missed$/)
  }
  expect(await axeViolations(page)).toEqual([])
  if (shot) await page.screenshot({ path: `${shot}/3-debrief.png`, fullPage: true })
})
