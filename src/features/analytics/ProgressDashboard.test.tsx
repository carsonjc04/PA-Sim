// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pance from '../../../content/blueprints/nccpa-pance-2025.json'
import { buildDashboard } from '../../domain/analytics/dashboard'
import { EVIDENCED_TASKS } from '../../domain/analytics/metrics'
import type { AttemptFact, MissFact } from '../../domain/analytics/types'
import type { StudyItem } from '../../domain/study/coverage'
import type { Blueprint } from '../../domain/study/schema'
import { axeViolations } from '../../test/axe'
import { ProgressDashboard, ProgressView } from './ProgressDashboard'

const mocks = vi.hoisted(() => ({ api: { analyticsDashboard: vi.fn() } }))
vi.mock('../../api/client', () => ({ api: mocks.api }))
afterEach(() => {
  cleanup()
  mocks.api.analyticsDashboard.mockReset()
})

const tags = (organSystems: string[]) => ({ organSystems, panceTasks: [...EVIDENCED_TASKS], topicTags: [], careSettings: [], ageGroups: [], eorRotations: [] })
const items: StudyItem[] = [
  { id: 'asthma', title: 'Wheezing and shortness of breath', kind: 'case', tags: tags(['pulmonary-system']), status: 'draft', blueprintReviews: [] },
  { id: 'respiratory', title: 'Cough and sore throat', kind: 'case', tags: tags(['pulmonary-system', 'eyes-ears-nose-throat']), status: 'draft', blueprintReviews: [] },
  { id: 'chest-pressure', title: 'Chest pressure with sweating', kind: 'case', tags: tags(['cardiovascular-system']), status: 'draft', blueprintReviews: [] },
]
const miss = (attemptId: string, o: Partial<MissFact>): MissFact => ({ evidenceId: `ev-${attemptId}`, attemptId, rubricItemId: 'item', kind: 'omission', errorType: 'data-gathering-omission', phase: 'history', label: 'Skipped red flags', kcIds: [], at: '2026-10-06T18:00:00.000Z', ...o })
const attempt = (id: string, scenarioId: string, submittedAt: string, misses: Partial<MissFact>[] = []): AttemptFact => ({
  attemptId: id,
  scenarioId,
  scenarioTitle: items.find((i) => i.id === scenarioId)!.title,
  contentVersionId: `${scenarioId}@x`,
  startedAt: new Date(Date.parse(submittedAt) - 600_000).toISOString(),
  submittedAt,
  tags: items.find((i) => i.id === scenarioId)!.tags,
  criticalSafetyError: misses.some((m) => m.kind === 'critical'),
  misses: misses.map((m) => miss(id, m)),
  diagnosisEvents: [],
  objectiveIds: [],
})

const dashboard = (attempts: AttemptFact[], due = 0) =>
  buildDashboard({
    now: new Date('2026-10-11T21:00:00Z'),
    timeZone: 'America/Denver',
    blueprint: pance as unknown as Blueprint,
    blueprintLabel: 'PANCE',
    items,
    library: null,
    attempts,
    retention: [],
    due: Array.from({ length: due }, (_, i) => ({ cardId: `c${i}`, label: `Card ${i}`, due: '2026-10-11T12:00:00.000Z' })),
    notYetAnalyzed: 0,
  })

const view = (data: ReturnType<typeof dashboard>) => render(<MemoryRouter><ProgressView data={data} /></MemoryRouter>)

describe('progress dashboard', () => {
  it('lists up to three priorities, each with why, a next action and its basis', () => {
    const data = dashboard([attempt('a1', 'chest-pressure', '2026-10-06T18:00:00.000Z', [{ kind: 'critical', errorType: 'unsafe-action', label: 'Let the patient drive', phase: 'treatment' }])], 7)
    view(data)
    const list = screen.getByRole('heading', { name: 'What to work on next' }).closest('section')!
    const entries = within(list).getAllByRole('listitem').filter((li) => li.classList.contains('progress-priority'))
    expect(entries).toHaveLength(3)
    expect(within(entries[0]).getByRole('heading', { level: 3 })).toHaveTextContent('Revisit a safety issue in Chest pressure with sweating')
    expect(within(entries[0]).getByText(/"Let the patient drive"/)).toBeInTheDocument()
    expect(within(entries[0]).getByRole('link', { name: /Retry Chest pressure with sweating/ })).toHaveAttribute('href', '/encounter/chest-pressure')
    expect(within(entries[0]).getByText('Based on 1 attempt · Not enough evidence yet')).toBeInTheDocument()
    expect(within(entries[0]).getByRole('link', { name: 'Debrief from Oct 6' })).toHaveAttribute('href', '/results/a1')
    expect(within(entries[1]).getByRole('link', { name: /Start a quick 5/ })).toHaveAttribute('href', '/review')
  })

  it('labels a single good case as not enough evidence, never as a percentage', () => {
    view(dashboard([attempt('a1', 'asthma', '2026-10-06T18:00:00.000Z')]))
    const table = screen.getByRole('table', { name: 'Body systems you have practiced' })
    const row = within(table).getByRole('row', { name: /Pulmonary System/ })
    expect(row).toHaveTextContent('1 attempt, 1 case')
    expect(row).toHaveTextContent('Not enough evidence yet')
    const result = within(row).getAllByRole('cell')[2]
    expect(result).toHaveTextContent('1 of 1 attempt')
    expect(result).not.toHaveTextContent('%')
  })

  it('shows a rate with its sample and interval once evidence is limited', () => {
    view(
      dashboard([
        attempt('a1', 'asthma', '2026-10-05T18:00:00.000Z', [{}]),
        attempt('a2', 'respiratory', '2026-10-06T18:00:00.000Z'),
        attempt('a3', 'asthma', '2026-10-07T18:00:00.000Z'),
      ]),
    )
    const row = within(screen.getByRole('table', { name: 'Body systems you have practiced' })).getByRole('row', { name: /Pulmonary System/ })
    expect(row).toHaveTextContent('67%')
    expect(row).toHaveTextContent(/2 of 3 attempts · likely \d+%–\d+%/)
    expect(row).toHaveTextContent('Limited evidence')
  })

  it('gives every week its own sample size', () => {
    view(dashboard([attempt('a1', 'asthma', '2026-09-29T18:00:00.000Z'), attempt('a2', 'respiratory', '2026-10-06T18:00:00.000Z'), attempt('a3', 'chest-pressure', '2026-10-07T18:00:00.000Z')]))
    const rows = within(screen.getByRole('table', { name: 'By study week, in your time zone' })).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['1 attempt, 1 case', '2 attempts, 2 cases'])
    for (const r of rows) expect(r).toHaveTextContent('Not enough evidence yet')
  })

  it('says plainly that it does not estimate readiness or compare with others', () => {
    view(dashboard([]))
    const limits = screen.getByRole('heading', { name: 'What this page is not' }).closest('section')!
    expect(limits).toHaveTextContent('does not estimate exam readiness')
    expect(limits).toHaveTextContent('no comparisons with other students or national figures')
    expect(document.body).not.toHaveTextContent(/chance of passing|will pass|percentile/i)
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = view(dashboard([attempt('a1', 'asthma', '2026-10-06T18:00:00.000Z', [{ errorType: 'premature-closure', phase: 'diagnosis' }])], 2))
    expect(await axeViolations(container)).toEqual([])
  })

  it('recovers from a failed load without hiding the rest of the page', async () => {
    mocks.api.analyticsDashboard.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(dashboard([]))
    render(<MemoryRouter><ProgressDashboard user="alice" /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Progress is unavailable right now')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'What to work on next' })).toBeInTheDocument()
  })
})
