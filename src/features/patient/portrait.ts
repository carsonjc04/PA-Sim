import { useState } from 'react'

// Case IDs with a committed portrait at public/portraits/<id>.webp (portrait.test.tsx keeps this in step with the files).
export const PORTRAIT_CASE_IDS: readonly string[] = ['asthma', 'chest-pressure', 'dysuria', 'metabolic', 'respiratory']

// The home plate pictures one authored case; the hero CTA opens the whole library, which has no default case.
export const FEATURED_CASE = { id: 'chest-pressure', title: 'Chest pressure with sweating', patient: 'Thomas Reed' }

export const patientPortraitSrc = (caseId: string) => (PORTRAIT_CASE_IDS.includes(caseId) ? `${import.meta.env.BASE_URL}portraits/${caseId}.webp` : null)

export const patientPortraitAlt = (name: string, caseTitle: string) => `${name}, the fictional patient in the ${caseTitle.toLowerCase()} case`

/** The portrait for a case, or null when there is none or it failed to load, so callers never show a broken image. */
export function usePatientPortrait(caseId: string) {
  const src = patientPortraitSrc(caseId)
  const [failed, setFailed] = useState<string | null>(null)
  return src && failed !== src ? { src, onError: () => setFailed(src) } : null
}
