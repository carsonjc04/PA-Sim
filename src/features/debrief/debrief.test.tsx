// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicAttempt, PublicDebrief } from '../../api/contracts'
import { axeViolations } from '../../test/axe'
import { DebriefPage } from './DebriefPage'

const mocks = vi.hoisted(() => ({ api: { attempt: vi.fn(), annotations: vi.fn(), notes: vi.fn(), remediation: vi.fn() } }))
vi.mock('../../api/client', () => ({ api: mocks.api, ApiRequestError: class extends Error {} }))
vi.mock('../review/RemediationPanel', () => ({ RemediationPanel: () => <section aria-labelledby="rp"><h2 id="rp">Turn misses into practice</h2></section> }))

const debrief: PublicDebrief = {
  gradingVersionId: 'grading-x', contentVersionId: 'chest-pressure@abc', gradedAt: '2026-10-11T10:10:00Z',
  categoryScores: { history: 86, exam: 75, diagnostics: 80, diagnosis: 70, treatment: 30, communication: 50 },
  rawScore: 65, finalScore: 59, passed: false, criticalSafetyError: true,
  criticalMessages: ['The patient should not drive themselves during a suspected cardiac emergency.'],
  strengths: ['Clarify onset'], missed: [], unnecessary: [], unsafe: [], correctDiagnosisLabel: 'Suspected acute coronary syndrome', diagnosisReasoning: '', idealPlan: ['Activate EMS'],
  reasoning: {
    misses: [
      { rubricItemId: 'drive', kind: 'unsafe', phase: 'treatment', label: 'Tell the patient to drive', whyItMattered: 'Should not self-transport.' },
      { rubricItemId: 'no-drive', kind: 'critical', phase: 'treatment', label: 'Tell the patient to drive', whyItMattered: 'The patient should not drive themselves.' },
      { rubricItemId: 'omit-ecg', kind: 'omission', phase: 'diagnostics', label: 'Obtain an ECG', whyItMattered: 'An ECG within 10 minutes changes management.' },
    ],
    timeline: [
      { seq: 1, offsetMs: 30_000, phase: 'history', type: 'finding', actionId: 'onset', label: 'Clarify onset', revealed: 'It began with exertion.', source: 'guided', key: true, confidence: null },
      { seq: 2, offsetMs: 125_000, phase: 'history', type: 'phase_locked', actionId: null, label: 'History locked', revealed: null, source: 'system', key: false, confidence: null },
      { seq: 3, offsetMs: 300_000, phase: 'diagnosis', type: 'diagnosis', actionId: 'acs', label: 'Suspected ACS', revealed: null, source: 'guided', key: true, confidence: 'unsure' },
    ],
    differential: [
      { id: 'acs', label: 'Suspected ACS', correct: true, chosen: true, reasoning: 'Exertional pressure with risk factors.' },
      { id: 'gerd', label: 'Reflux', correct: false, chosen: false, reasoning: null },
    ],
    keyFindingsBeforeDiagnosis: [{ actionId: 'onset', label: 'Clarify onset', revealed: 'It began with exertion.' }],
    missedEvidence: [{ id: 'omit-ecg', phase: 'diagnostics', label: 'Obtain an ECG', feedback: 'An ECG within 10 minutes changes management.' }],
    historyChecklist: [
      { actionId: 'onset', label: 'Clarify onset', question: 'When did this start?', status: 'asked', offsetMs: 30_000, source: 'voice' },
      { actionId: 'radiation', label: 'Ask about radiation', question: 'Does the pain spread anywhere?', status: 'asked_with_hint', offsetMs: 95_000, source: 'voice' },
      { actionId: 'risk', label: 'Ask about cardiac risk factors', question: 'Do you smoke or have diabetes?', status: 'missed', offsetMs: null, source: null },
    ],
    hintsUsed: 3,
    modeChanges: [{ offsetMs: 5_000, mode: 'voice' }],
    provenance: 'Built from this case’s authored reasoning. Not clinically validated.',
  },
}
const attempt = {
  id: 'att', scenarioId: 'chest-pressure', status: 'submitted', debrief,
  scenario: { summary: { title: 'Chest pressure with sweating' }, phases: [{ id: 'history', label: 'History', actions: [{ id: 'onset', label: 'Clarify onset' }] }, { id: 'diagnostics', label: 'Diagnostics', actions: [] }, { id: 'diagnosis', label: 'Diagnosis', actions: [] }, { id: 'treatment', label: 'Treatment & disposition', actions: [] }], diagnoses: [{ id: 'acs', label: 'Suspected ACS' }, { id: 'gerd', label: 'Reflux' }], planOptions: [] },
} as unknown as PublicAttempt

beforeEach(() => {
  mocks.api.attempt.mockResolvedValue(attempt)
  mocks.api.annotations.mockResolvedValue([{ targetKind: 'diagnosis', targetId: 'gerd', marks: ['ruled_out'] }, { targetKind: 'action', targetId: 'onset', marks: ['revisit'] }])
  mocks.api.notes.mockResolvedValue({ body: 'Look up HEART score', version: 1, updatedAt: null })
})
afterEach(cleanup)

const renderDebrief = () => render(<MemoryRouter initialEntries={['/results/att']}><Routes><Route path="/results/:attemptId" element={<DebriefPage />} /></Routes></MemoryRouter>)

describe('reasoning-first debrief', () => {
  it('shows the full key-question checklist with asked, asked-with-hint and missed states, times and hint count', async () => {
    renderDebrief()
    const section = (await screen.findByRole('heading', { name: 'History checklist: what did I ask?' })).closest('section')!
    const rows = within(section).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Asked · Under 1 min')
    expect(rows[0]).toHaveTextContent('Clarify onset')
    expect(rows[1]).toHaveTextContent('Asked with hint · 1 min')
    expect(rows[2]).toHaveTextContent('Missed')
    expect(rows[2]).toHaveTextContent('Do you smoke or have diabetes?')
    expect(section).toHaveTextContent('Hints used: 3.')
    expect(section).toHaveTextContent('switched the history mode 1 time (to voice at under 1 min)')
  })

  it('orders sections: safety, misses, timeline, differential, retrieve later, then score', async () => {
    renderDebrief()
    await screen.findByRole('heading', { level: 1, name: 'Chest pressure with sweating' })
    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim())
    expect(h2).toEqual(['Critical safety issue', 'What did I miss, and why did it matter?', 'History checklist: what did I ask?', 'Reasoning timeline', 'What evidence shaped the differential?', 'What should I retrieve later?', 'Turn misses into practice', 'Score and rubric'])
    expect(screen.queryByText(/59%/, { selector: 'h1 *, h1, header *' })).not.toBeInTheDocument()
  })

  it('explains each miss with why it mattered, showing a critical item once', async () => {
    renderDebrief()
    const section = (await screen.findByRole('heading', { name: 'What did I miss, and why did it matter?' })).closest('section')!
    expect(within(section).getAllByText('Tell the patient to drive')).toHaveLength(1)
    expect(within(section).getByText('Critical safety issue')).toBeInTheDocument()
    expect(section).toHaveTextContent('Why it mattered: An ECG within 10 minutes changes management.')
  })

  it('shows the timeline with relative times, key markers, confidence and the learner’s own marks as text', async () => {
    renderDebrief()
    const timeline = (await screen.findByRole('heading', { name: 'Reasoning timeline' })).closest('section')!
    const items = within(timeline).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Under 1 min')
    expect(items[0]).toHaveTextContent('Key')
    expect(await within(timeline).findByText('You flagged this')).toBeInTheDocument()
    expect(items[1]).toHaveTextContent('2 min')
    expect(items[2]).toHaveTextContent('You were unsure')
  })

  it('shows evidence before commitment, missed evidence and authored reasoning per option', async () => {
    renderDebrief()
    const diff = (await screen.findByRole('heading', { name: 'What evidence shaped the differential?' })).closest('section')!
    expect(diff).toHaveTextContent('Clarify onset: It began with exertion.')
    expect(diff).toHaveTextContent('Obtain an ECG (Diagnostics): An ECG within 10 minutes changes management.')
    expect(diff).toHaveTextContent('Best fit for this case')
    expect(await within(diff).findByText('You ruled this out')).toBeInTheDocument()
    expect(diff).toHaveTextContent('No reasoning was authored for this option.')
  })

  it('lists flagged items and notes to retrieve later, and has no axe violations', async () => {
    const { container } = renderDebrief()
    const retrieve = (await screen.findByRole('heading', { name: 'What should I retrieve later?' })).closest('section')!
    expect(await within(retrieve).findByText('Look up HEART score')).toBeInTheDocument()
    expect(within(retrieve).getByText('Clarify onset')).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })
})
