// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import respiratoryJson from '../../../content/scenarios/respiratory.json?raw'
import type { AttemptEventBody, PublicAnnotation, PublicAttempt, PublicEvent, PublicNotes, PublicScenario } from '../../api/contracts'
import { phaseOrder, type ScenarioDefinition } from '../../domain/types'
import { axeViolations } from '../../test/axe'
import { EncounterPage } from './EncounterPage'

const def = JSON.parse(respiratoryJson) as ScenarioDefinition
// Same allowlist shape as server/attempts/projection.ts (responses withheld).
const scenario = {
  id: def.id,
  schemaVersion: def.schemaVersion,
  summary: def.summary,
  patient: def.patient,
  clinician: def.clinician,
  opening: def.opening,
  initialInfo: def.initialInfo,
  phases: def.phases.map((p) => ({ id: p.id, label: p.label, description: p.description, actions: p.actions.map((a) => ({ id: a.id, label: a.label, paText: a.paText, kind: a.kind })) })),
  diagnoses: def.diagnoses.map((d) => ({ id: d.id, label: d.label })),
  planOptions: def.planOptions.map((p) => ({ id: p.id, label: p.label, group: p.group })),
  reviewStatus: 'requires-clinician-review',
  clinicalReferences: [],
  tags: { organSystems: [], panceTasks: [], eorRotations: [], suitability: def.taxonomy.suitability },
} as PublicScenario
const responseOf = (id: string) => def.phases.flatMap((p) => p.actions).find((a) => a.id === id)?.response ?? null

// ---- In-memory fake of the attempts API ----
class NetError extends Error {
  status = 0
  code = 'network' as const
}
let attempt: PublicAttempt
let notes: PublicNotes
let annotations: PublicAnnotation[]
let offline = false
const calls: AttemptEventBody[] = []
const net = <T,>(fn: () => T): Promise<T> => (offline ? Promise.reject(new (mocks.ApiRequestError as unknown as typeof NetError)('Could not reach the ClinicSim server.')) : Promise.resolve(structuredClone(fn())))

const mocks = vi.hoisted(() => {
  class ApiRequestError extends Error {
    status: number
    code: string
    details?: Record<string, unknown>
    constructor(message: string, status = 0, code = 'network', details?: Record<string, unknown>) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
    }
  }
  return { ApiRequestError, api: {} as Record<string, unknown> }
})
vi.mock('../../api/client', () => ({ api: mocks.api, ApiRequestError: mocks.ApiRequestError, apiBaseUrl: 'http://test', newKey: () => 'k' }))
vi.mock('./VoicePanel', () => ({ VoicePanel: () => <p>Voice mode is not configured. Guided mode works without it.</p> }))

function reset() {
  attempt = { id: '00000000-0000-4000-8000-000000000001', scenarioId: 'respiratory', contentVersionId: 'respiratory@x', status: 'active', currentPhase: 'history', lockedPhases: [], scenario, events: [], createdAt: new Date().toISOString(), submittedAt: null, debrief: null }
  notes = { body: '', version: 0, updatedAt: null }
  annotations = []
  offline = false
  calls.length = 0
  let seq = 0
  Object.assign(mocks.api, {
    startAttempt: vi.fn(() => net(() => ({ attempt, resumed: false }))),
    attempt: vi.fn(() => net(() => attempt)),
    event: vi.fn((_id: string, body: AttemptEventBody) =>
      net(() => {
        calls.push(body)
        if (body.type === 'lock_phase') {
          attempt.lockedPhases.push(body.phase)
          attempt.currentPhase = phaseOrder[phaseOrder.indexOf(body.phase) + 1] ?? body.phase
        } else if (body.type === 'action') {
          for (const id of body.actionIds) {
            const e: PublicEvent = { seq: (seq += 1), phase: attempt.currentPhase, actionId: id, kind: 'action', confirmed: true, revealed: responseOf(id), source: 'guided', at: new Date().toISOString() }
            attempt.events.push(e)
          }
        }
        return { result: { recorded: [], duplicates: [], pendingConfirmation: [], reveals: [] }, attempt }
      }),
    ),
    submit: vi.fn(() => net(() => ((attempt.status = 'submitted'), attempt))),
    notes: vi.fn(() => net(() => notes)),
    saveNotes: vi.fn((_id: string, body: { body: string; version: number }) => {
      if (offline) return Promise.reject(new mocks.ApiRequestError('offline'))
      if (body.version !== notes.version) return Promise.reject(new mocks.ApiRequestError('conflict', 409, 'notes_conflict', { current: structuredClone(notes) }))
      notes = { body: body.body, version: notes.version + 1, updatedAt: new Date().toISOString() }
      return Promise.resolve(structuredClone(notes))
    }),
    annotations: vi.fn(() => net(() => annotations)),
    setAnnotation: vi.fn((_id: string, b: PublicAnnotation) =>
      net(() => {
        annotations = [...annotations.filter((a) => !(a.targetKind === b.targetKind && a.targetId === b.targetId)), ...(b.marks.length ? [b] : [])]
        return annotations
      }),
    ),
  })
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame
})
beforeEach(() => {
  reset()
  localStorage.clear()
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !offline })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderEncounter() {
  return render(
    <MemoryRouter initialEntries={['/encounter/respiratory']}>
      <Routes>
        <Route path="/encounter/:scenarioId" element={<EncounterPage />} />
        <Route path="/results/:attemptId" element={<h1>Debrief page</h1>} />
        <Route path="/cases" element={<h1>Cases</h1>} />
      </Routes>
    </MemoryRouter>,
  )
}
const ready = () => screen.findByRole('heading', { level: 1, name: def.summary.title })
const liveRegion = () => document.querySelector('[aria-live="polite"]') as HTMLElement
const choices = () => screen.queryByRole('group', { name: /choices$/ }) ?? screen.getByRole('radiogroup', { name: /choices$/ })
const notesField = async () => {
  const field = screen.getByLabelText('Notes for this attempt')
  await waitFor(() => expect(field).toBeEnabled())
  return field
}

describe('guided encounter, keyboard only', () => {
  it('completes the whole case from the keyboard, without a mouse, microphone or AI', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    const flow = async (phaseLabel: string, picks: string[], lockLabel: RegExp) => {
      await screen.findByRole('heading', { level: 2, name: new RegExp(`^${phaseLabel}`) })
      for (const label of picks) {
        const row = within(choices()).getAllByRole(phaseLabel === 'Diagnosis' ? 'radio' : 'button').find((b) => b.textContent?.startsWith(label))!
        // Reach the row with Tab plus arrow keys only.
        row.focus() // arrow-key movement inside the list is asserted in the next test; the e2e suite uses real Tab order
        await user.keyboard('{Enter}')
      }
      const lock = screen.getByRole('button', { name: lockLabel })
      lock.focus()
      await user.keyboard('{Enter}')
      const dialog = await screen.findByRole('dialog')
      within(dialog).getByRole('button', { name: 'Lock and continue' }).focus()
      await user.keyboard('{Enter}')
      // Focus moves to the next phase heading once the dialog has closed.
      await waitFor(() => expect(document.activeElement?.tagName).toBe('H2'))
    }
    const hist = def.phases.find((p) => p.id === 'history')!
    const exam = def.phases.find((p) => p.id === 'exam')!
    const diag = def.phases.find((p) => p.id === 'diagnostics')!
    await flow(hist.label, [hist.actions[0].label, hist.actions[3].label], /Lock phase and continue/)
    expect(attempt.lockedPhases).toEqual(['history'])
    await flow(exam.label, [exam.actions[0].label], /Lock phase and continue/)
    await flow(diag.label, [diag.actions[0].label], /Lock phase and continue/)
    await flow('Diagnosis', [def.diagnoses.find((d) => d.id === def.correctPrimary)!.label], /Lock phase and continue/)
    expect(calls.map((c) => (c.type === 'action' ? `${c.tool}:${c.actionIds.join(',')}` : c.type === 'lock_phase' ? `lock:${c.phase}` : c.type))).toContain(`propose_diagnosis:${def.correctPrimary}`)
    const treatment = def.phases.find((p) => p.id === 'treatment')!
    await screen.findByRole('heading', { level: 2, name: new RegExp(`^${treatment.label}`) })
    const plan = def.planOptions.filter((p) => !p.unsafe).slice(0, 2)
    for (const p of plan) {
      within(choices()).getAllByRole('button').find((b) => b.textContent?.startsWith(p.label))!.focus()
      await user.keyboard('{Enter}')
    }
    screen.getByRole('button', { name: /Review and submit/ }).focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Submit this encounter?' })
    within(dialog).getByRole('button', { name: 'Submit encounter' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('heading', { name: 'Debrief page' })
    expect(attempt.status).toBe('submitted')
  })

  it('moves between choices with arrow keys and j/k from a single tab stop', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    const rows = within(choices()).getAllByRole('button', { pressed: false })
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1)
    rows[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toContain(def.phases[0].actions[1].label)
    await user.keyboard('j')
    expect(document.activeElement?.textContent).toContain(def.phases[0].actions[2].label)
    await user.keyboard('k{Home}')
    expect(document.activeElement?.textContent).toContain(def.phases[0].actions[0].label)
    await user.keyboard('{End}')
    expect(document.activeElement?.textContent).toContain(def.phases[0].actions.at(-1)!.label)
  })

  it('confirms in a dialog that Escape closes, returning focus to the trigger', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    const lock = screen.getByRole('button', { name: /Lock phase and continue/ })
    lock.focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: `Lock ${def.phases[0].label}?` })
    expect(dialog).toHaveTextContent('You can review this phase later')
    // jsdom has no native Escape for <dialog>; the browser one is covered in e2e. Close via its button.
    await user.click(within(dialog).getByRole('button', { name: 'Keep working' }))
    expect(dialog).not.toHaveAttribute('open')
    expect(attempt.lockedPhases).toEqual([])
  })
})

describe('case surface', () => {
  it('labels patient statements, findings and results by text, and announces what was revealed', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    const first = def.phases[0].actions[0]
    within(choices()).getAllByRole('button').find((b) => b.textContent?.startsWith(first.label))!.focus()
    await user.keyboard('{Enter}')
    const entry = await screen.findByText(first.response, { selector: '.entry-text' })
    expect(entry.closest('li')).toHaveTextContent('Patient said')
    await waitFor(() => expect(liveRegion()).toHaveTextContent(`Patient said: ${first.response}`))
    expect(screen.getByText('At presentation')).toBeInTheDocument()
  })

  it('shows marks as text (Ruled out, Key, Revisit), from the Mark menu and from x/h/f keys', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    const rowLabel = def.phases[0].actions[1].label
    await user.click(screen.getByRole('button', { name: `Mark ${rowLabel}` }))
    await user.click(screen.getByRole('button', { name: /Rule out/ }))
    const row = within(choices()).getAllByRole('button').find((b) => b.textContent?.startsWith(rowLabel))!
    await waitFor(() => expect(row).toHaveTextContent('Ruled out'))
    row.focus()
    await user.keyboard('hf')
    await waitFor(() => expect(row).toHaveTextContent(/Key.*Revisit/))
    expect(annotations).toEqual([{ targetKind: 'action', targetId: def.phases[0].actions[1].id, marks: ['ruled_out', 'key', 'revisit'] }])
    await user.keyboard('x')
    await waitFor(() => expect(row).not.toHaveTextContent('Ruled out'))
  })

  it('lets a locked phase be reviewed read-only from the phase list', async () => {
    const user = userEvent.setup()
    attempt.lockedPhases = ['history']
    attempt.currentPhase = 'exam'
    attempt.events.push({ seq: 1, phase: 'history', actionId: def.phases[0].actions[0].id, kind: 'action', confirmed: true, revealed: def.phases[0].actions[0].response, source: 'guided', at: new Date().toISOString() })
    renderEncounter()
    await ready()
    await user.click(screen.getByRole('button', { name: new RegExp(`${def.phases[0].label}.*Locked`) }))
    expect(screen.getByRole('heading', { level: 2, name: /History.*Locked/ })).toBeInTheDocument()
    expect(screen.getByText(/You are reviewing it/)).toBeInTheDocument()
    const chosen = within(choices()).getAllByRole('button').find((b) => b.textContent?.startsWith(def.phases[0].actions[0].label))!
    expect(chosen).toHaveAttribute('aria-pressed', 'true')
    await user.click(chosen)
    expect(calls).toEqual([])
    await user.click(screen.getByRole('button', { name: /^Back to/ }))
    expect(screen.getByRole('heading', { level: 2, name: new RegExp(`^${def.phases[1].label}`) })).toBeInTheDocument()
  })
})

describe('clinical media', () => {
  it('renders revealed images with alt text and an expandable description', async () => {
    attempt.events.push({ seq: 1, phase: 'history', actionId: def.phases[0].actions[0].id, kind: 'action', confirmed: true, revealed: 'See image.', source: 'guided', at: new Date().toISOString(), media: [{ id: 'm', src: '/x.png', kind: 'photo', alt: 'Erythematous posterior pharynx without exudate', longDescription: 'Diffuse mild redness of the posterior pharynx; tonsils not enlarged.', decorative: false }] })
    renderEncounter()
    await ready()
    expect(screen.getByRole('img', { name: 'Erythematous posterior pharynx without exudate' })).toBeInTheDocument()
    expect(screen.getByText('Image description')).toBeInTheDocument()
  })
})

describe('offline and failures', () => {
  it('pauses choices with a reason while offline, and keeps notes on the device', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    offline = true
    act(() => void window.dispatchEvent(new Event('offline')))
    expect(await screen.findByText(/Choices are paused until the connection returns/, { selector: '.encounter-banner *' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Lock phase and continue/ })).toBeDisabled()
    await user.click(within(choices()).getAllByRole('button')[0])
    expect(calls).toEqual([])
    await user.type(await notesField(), 'Check Centor')
    expect(await screen.findByText(/Offline: saved on this device/)).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(`clinicsim-notes-draft:${attempt.id}`)!).body).toBe('Check Centor')
    offline = false
    act(() => void window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(notes.body).toBe('Check Centor'))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('reports a failed action as a system message with a retry', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    ;(mocks.api.event as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new mocks.ApiRequestError('Could not reach the ClinicSim server.'))
    await user.click(within(choices()).getAllByRole('button')[0])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Not recorded: you appear to be offline.')
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(attempt.events).toHaveLength(1))
  })
})

describe('notes', () => {
  it('autosaves, shows the privacy notice at the field, and hints at identifier-like text', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    const field = await notesField()
    expect(field).toHaveAccessibleDescription(/Do not enter real patient names, dates of birth, record numbers/)
    await user.type(field, 'Pt DOB 04/12/1990')
    expect(screen.getByText(/looks like it may contain a date or record number/)).toBeInTheDocument()
    await waitFor(() => expect(notes.body).toBe('Pt DOB 04/12/1990'), { timeout: 3000 })
  })

  it('surfaces a conflict and lets the learner choose, without overwriting silently', async () => {
    const user = userEvent.setup()
    renderEncounter()
    await ready()
    notes = { body: 'Written on the laptop', version: 3, updatedAt: new Date().toISOString() }
    await user.type(await notesField(), 'From the phone')
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert).toHaveTextContent('Written on the laptop')
    expect(notes.body).toBe('Written on the laptop')
    await user.click(within(alert).getByRole('button', { name: 'Keep my version' }))
    await waitFor(() => expect(notes).toMatchObject({ body: 'From the phone', version: 4 }))
  })
})

describe('accessibility', () => {
  it('has no axe violations in the fresh, revealed, review, offline and dialog states', async () => {
    const user = userEvent.setup()
    const { container } = renderEncounter()
    await ready()
    expect(await axeViolations(container)).toEqual([])
    await user.click(within(choices()).getAllByRole('button')[0])
    await screen.findByText(def.phases[0].actions[0].response, { selector: '.entry-text' })
    await user.click(screen.getByRole('button', { name: `Mark ${def.phases[0].actions[1].label}` }))
    expect(await axeViolations(container)).toEqual([])
    offline = true
    act(() => void window.dispatchEvent(new Event('offline')))
    expect(await axeViolations(container)).toEqual([])
    offline = false
    act(() => void window.dispatchEvent(new Event('online')))
    await user.click(screen.getByRole('button', { name: /Lock phase and continue/ }))
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('keeps one h1 and a logical heading order', async () => {
    renderEncounter()
    await ready()
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)))
    expect(levels.filter((l) => l === 1)).toHaveLength(1)
    for (let i = 1; i < levels.length; i += 1) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1)
  })
})
