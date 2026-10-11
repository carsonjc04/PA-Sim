import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

export const WIDTHS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-360', width: 360, height: 780 },
] as const

/** Pixels the page scrolls sideways; 0 means no horizontal overflow. */
export const horizontalOverflow = (page: Page) => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth))

/** Sets the development identity before the app reads it. Unique per test run so attempts never collide. */
export async function useIdentity(page: Page, name = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`) {
  await page.addInitScript((n) => window.localStorage.setItem('clinicsim-dev-user', n), name)
  return name
}

export async function axeViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  return result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }))
}

import { readFileSync } from 'node:fs'
import type { APIRequestContext } from '@playwright/test'

export const API = 'http://localhost:8788'
type Selections = Record<'history' | 'exam' | 'diagnostics' | 'diagnosis' | 'treatment', string[]>
const tool: Record<string, string> = { history: 'record_history_topics', exam: 'request_physical_exam', diagnostics: 'order_diagnostic_test' }
const planTool: Record<string, string> = { treatment: 'propose_treatment_plan', counseling: 'propose_treatment_plan', disposition: 'record_disposition', 'follow-up': 'record_follow_up', return: 'record_follow_up' }
let keySeq = 0

/** Plays a shipped fixture through the real API (same calls as the guided UI) and optionally submits. Returns the attempt id. */
export async function playFixture(request: APIRequestContext, user: string, scenarioId: string, kind: string, submit = true): Promise<string> {
  const fx = JSON.parse(readFileSync(`content/scenarios/${scenarioId}.fixtures.json`, 'utf8')).fixtures.find((f: { kind: string }) => f.kind === kind).selections as Selections
  const scenario = JSON.parse(readFileSync(`content/scenarios/${scenarioId}.json`, 'utf8')) as { planOptions: { id: string; group: string }[] }
  const headers = () => ({ 'X-Dev-User': user, 'Idempotency-Key': `e2e-${Date.now()}-${(keySeq += 1)}` })
  const post = async (path: string, data?: object) => {
    const res = await request.post(`${API}${path}`, { headers: headers(), data })
    if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`)
    return res.json()
  }
  const id = (await post('/api/attempts', { scenarioId })).attempt.id as string
  for (const phase of ['history', 'exam', 'diagnostics'] as const) {
    if (fx[phase].length) await post(`/api/attempts/${id}/events`, { type: 'action', tool: tool[phase], actionIds: fx[phase] })
    await post(`/api/attempts/${id}/events`, { type: 'lock_phase', phase })
  }
  await post(`/api/attempts/${id}/events`, { type: 'action', tool: 'propose_diagnosis', actionIds: fx.diagnosis, confirmed: true })
  await post(`/api/attempts/${id}/events`, { type: 'lock_phase', phase: 'diagnosis' })
  for (const o of fx.treatment) await post(`/api/attempts/${id}/events`, { type: 'action', tool: planTool[scenario.planOptions.find((p) => p.id === o)!.group], actionIds: [o], confirmed: true })
  if (submit) await post(`/api/attempts/${id}/submit`)
  return id
}
