// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import chestPressureJson from '../../../content/scenarios/chest-pressure.json?raw'
import { PatientPortrait } from './PatientPortrait'
import { FEATURED_CASE, PORTRAIT_CASE_IDS, patientPortraitAlt, patientPortraitSrc } from './portrait'

const idsIn = (paths: string[], ext: string) => paths.map((p) => p.split('/').pop()!.slice(0, -ext.length))

afterEach(cleanup)

describe('patient portraits', () => {
  it('lists exactly the committed portrait files', () => {
    const files = idsIn(Object.keys(import.meta.glob('/public/portraits/*.webp')), '.webp')
    expect([...PORTRAIT_CASE_IDS].sort()).toEqual(files.sort())
  })

  it('has a portrait for every authored case', () => {
    const cases = idsIn(Object.keys(import.meta.glob(['/content/scenarios/*.json', '!**/*.fixtures.json'])), '.json')
    expect(cases.length).toBeGreaterThan(0)
    for (const id of cases) expect(patientPortraitSrc(id)).toBe(`/portraits/${id}.webp`)
  })

  it('names the featured case as authored, and it has a portrait', () => {
    const s = JSON.parse(chestPressureJson)
    expect(s.id).toBe(FEATURED_CASE.id)
    expect({ title: s.summary.title, patient: s.patient.name }).toEqual({ title: FEATURED_CASE.title, patient: FEATURED_CASE.patient })
    expect(patientPortraitSrc(FEATURED_CASE.id)).not.toBeNull()
  })

  it('renders nothing for a case without a portrait', () => {
    const { container } = render(<PatientPortrait caseId="no-such-case" alt="x" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('removes the image when it fails to load instead of showing a broken image', () => {
    render(<PatientPortrait caseId="chest-pressure" alt={patientPortraitAlt('Thomas Reed', 'Chest pressure with sweating')} />)
    const img = screen.getByRole('img', { name: 'Thomas Reed, the fictional patient in the chest pressure with sweating case' })
    fireEvent.error(img)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
