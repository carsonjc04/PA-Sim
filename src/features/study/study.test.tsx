// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import surgeryJson from '../../../content/blueprints/paea-eor-surgery-2023.json?raw'
import taxonomyJson from '../../../content/taxonomy.json?raw'
import type { PublicBlueprintSummary, PublicCoverage, PublicScenario, PublicTaxonomy } from '../../api/contracts'
import { alignmentClaim, computeCoverage, fullExamGate, type StudyItem } from '../../domain/study/coverage'
import type { Blueprint } from '../../domain/study/schema'
import { CaseFilters } from './CaseFilters'
import { useCaseFilters } from './filterState'
import { RotationMode } from './RotationMode'
import { StudyHome } from './StudyHome'


// Real shipped content, read as text so the browser tsconfig needs no JSON or Node typings.
const taxonomyFile = JSON.parse(taxonomyJson)
const active = (list: { id: string; label: string; status: string }[]) => list.filter((t) => t.status === 'active').map(({ id, label }) => ({ id, label }))
const taxonomy: PublicTaxonomy = { organSystems: active(taxonomyFile.organSystems), panceTasks: active(taxonomyFile.panceTasks), eorRotations: active(taxonomyFile.eorRotations) }
const surgery: Blueprint = JSON.parse(surgeryJson)

const summary = (bp: Blueprint, lifecycle: PublicBlueprintSummary['lifecycle'] = 'current'): PublicBlueprintSummary => ({
  id: bp.id,
  issuer: bp.issuer,
  exam: bp.exam,
  rotation: bp.rotation,
  title: bp.title,
  versionLabel: bp.versionLabel,
  lifecycle,
  effectiveFrom: bp.effectiveFrom,
  effectiveUntil: bp.effectiveUntil,
  dateNotes: bp.dateNotes,
  source: bp.source,
  transcriptionVerified: false,
  examItems: bp.examStructure.items,
  notes: bp.notes,
})
const coverageOf = (bp: Blueprint, items: StudyItem[]): PublicCoverage => ({
  blueprint: summary(bp),
  coverage: computeCoverage(bp, items),
  secondaryTargets: [],
  items: items.map((i) => ({ id: i.id, title: i.title })),
  fullExam: fullExamGate(bp, items),
  alignment: alignmentClaim(bp, items),
})

const mocks = vi.hoisted(() => ({ studyTaxonomy: vi.fn(), blueprints: vi.fn(), coverage: vi.fn(), studyPlan: vi.fn(), sprints: vi.fn(), answerSprint: vi.fn() }))
vi.mock('../../api/client', () => ({ api: mocks, ApiRequestError: class extends Error {} }))

beforeEach(() => {
  mocks.studyTaxonomy.mockResolvedValue(taxonomy)
  mocks.blueprints.mockResolvedValue([summary(surgery)])
  mocks.coverage.mockResolvedValue(coverageOf(surgery, []))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('rotation coverage never implies complete coverage', () => {
  const renderSurgery = () =>
    render(
      <MemoryRouter initialEntries={['/study/rotation/surgery']}>
        <Routes>
          <Route path="/study/rotation/:rotationId" element={<RotationMode user={null} />} />
        </Routes>
      </MemoryRouter>,
    )

  it('states how many categories have cases, that it is not a full exam, and that it is not aligned', async () => {
    renderSurgery()
    const banner = await screen.findByRole('region', { name: 'Coverage summary' })
    expect(banner).toHaveTextContent('0 of 10 content categories have at least one practice case; 10 categories have none yet.')
    expect(banner).toHaveTextContent('Not a full-length exam.')
    expect(banner).toHaveTextContent('A full-length exam needs 100 distinct approved items')
    expect(banner).toHaveTextContent('Not aligned to this blueprint.')
    expect(banner).toHaveTextContent('not yet been double-checked')
  })

  it('marks every weighted cell with no case as missing and every zero-item cell as not on the exam', async () => {
    renderSurgery()
    const table = await screen.findByRole('table')
    const weighted = surgery.cells!.filter((c) => c.items > 0).length
    expect(within(table).getAllByText('no practice case yet')).toHaveLength(weighted)
    expect(within(table).getAllByText('No items on the exam')).toHaveLength(surgery.cells!.length - weighted)
    expect(screen.getAllByText('Not yet authored')).toHaveLength(surgery.contentCategories.length)
  })

  it('offers no exam simulation action', async () => {
    renderSurgery()
    await screen.findByRole('table')
    const actions = [...screen.queryAllByRole('link'), ...screen.queryAllByRole('button')].map((el) => el.textContent ?? '')
    expect(actions.filter((t) => /simulat|full[- ]length|take (the )?exam|practice exam/i.test(t))).toEqual([])
  })

  it('shows the source document, retrieval date and checksum', async () => {
    renderSurgery()
    const source = await screen.findByRole('complementary', { name: 'Blueprint source' })
    expect(within(source).getByRole('link')).toHaveAttribute('href', surgery.source.documentUrl)
    expect(source).toHaveTextContent(`Retrieved ${surgery.source.retrievedAt}`)
    expect(source).toHaveTextContent(surgery.source.sha256.slice(0, 12))
  })

  it('lists all seven core rotations to choose from', async () => {
    render(
      <MemoryRouter initialEntries={['/study/rotation']}>
        <Routes>
          <Route path="/study/rotation" element={<RotationMode user={null} />} />
        </Routes>
      </MemoryRouter>,
    )
    const links = await screen.findAllByRole('link')
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual(taxonomy.eorRotations.map((r) => `/study/rotation/${r.id}`).sort())
  })
})

describe('study home', () => {
  it('links the four modes and says no full-length simulations are offered', () => {
    render(
      <MemoryRouter>
        <StudyHome />
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/study/rotation', '/study/pance', '/study/mixed', '/study/sprint'])
    expect(screen.getByRole('heading', { name: 'No full-length exam simulations yet' })).toBeInTheDocument()
  })
})

const scenario = (id: string, organSystems: string[], panceTasks: string[], eorRotations: string[]) => ({ id, summary: { title: id }, tags: { organSystems, panceTasks, eorRotations } }) as unknown as PublicScenario
const library = [
  scenario('chest-pressure', ['cardiovascular-system'], ['formulating-the-most-likely-diagnosis'], ['emergency-medicine']),
  scenario('metabolic', ['endocrine-system'], ['health-maintenance-education-prevention'], ['family-medicine']),
]

function Harness() {
  const f = useCaseFilters()
  const location = useLocation()
  const shown = library.filter(f.matches)
  return (
    <>
      <CaseFilters taxonomy={f.taxonomy} failed={f.taxonomyFailed} filters={f.filters} onChange={f.set} onClear={f.clear} active={f.active} />
      <span data-testid="url">{location.search}</span>
      <ul aria-label="results">
        {shown.map((s) => (
          <li key={s.id}>{s.id}</li>
        ))}
      </ul>
      {f.active && shown.length === 0 && <p role="status">{f.emptyMessage}</p>}
    </>
  )
}
const renderFilters = (url = '/cases') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Harness />
    </MemoryRouter>,
  )

describe('case filters', () => {
  it('offers every PANCE system, every task and every core rotation', async () => {
    renderFilters()
    const system = await screen.findByRole('combobox', { name: 'PANCE system' })
    const options = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.getAttribute('value')).filter(Boolean)
    expect(options(system)).toHaveLength(15)
    expect(options(screen.getByRole('combobox', { name: 'PANCE task' }))).toEqual(taxonomy.panceTasks.map((t) => t.id))
    expect(options(screen.getByRole('combobox', { name: 'EOR rotation' }))).toEqual(taxonomy.eorRotations.map((r) => r.id))
    expect(options(screen.getByRole('combobox', { name: 'PANCE task' }))).not.toContain('patient-education')
  })

  it('filters by a system and task pair from the URL', async () => {
    renderFilters('/cases?system=endocrine-system&task=health-maintenance-education-prevention')
    await screen.findByRole('combobox', { name: 'PANCE system' })
    expect(within(screen.getByRole('list', { name: 'results' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['metabolic'])
  })

  it('shows an explicit empty state for a pair with no cases, and clears it', async () => {
    renderFilters('/cases?system=renal-system&task=clinical-intervention')
    expect(await screen.findByRole('status')).toHaveTextContent('No cases are authored for Renal System × Clinical Intervention yet.')
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByTestId('url')).toHaveTextContent('')
    expect(within(screen.getByRole('list', { name: 'results' })).getAllByRole('listitem')).toHaveLength(2)
  })

  it('filters by rotation', async () => {
    renderFilters()
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'EOR rotation' }), 'surgery')
    expect(screen.getByTestId('url')).toHaveTextContent('?rotation=surgery')
    expect(screen.getByRole('status')).toHaveTextContent('No cases are authored for Surgery yet.')
  })
})
