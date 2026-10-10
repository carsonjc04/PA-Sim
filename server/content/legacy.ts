import type { ScenarioDefinition } from '../../src/domain/types'

/**
 * Snapshots stored before schema 2.0 have no lifecycle, taxonomy or waivers. This adapter fills
 * the missing administrative fields at read time so old attempts still render and grade; it never
 * rewrites the stored snapshot, and grading reads only fields that already existed in v1.
 */
export function upgradeStoredDefinition(stored: unknown): ScenarioDefinition {
  const d = stored as Partial<ScenarioDefinition> & { reviewStatus?: string }
  if (d.lifecycle && d.taxonomy) return d as ScenarioDefinition
  const references = (d.clinicalReferences ?? []).map((r) => {
    const legacy = r as { title: string; organization: string; url: string; reviewed?: string }
    return { title: legacy.title, organization: legacy.organization, url: legacy.url, accessedAt: legacy.reviewed ?? '1970-01-01', specificity: 'general' as const, verified: false }
  })
  return {
    ...(d as ScenarioDefinition),
    clinicalReferences: references,
    criticalWaivers: d.criticalWaivers ?? [],
    spoilerTerms: d.spoilerTerms ?? [],
    taxonomy: { provenance: 'author-proposed-unreviewed', organSystems: [], panceTasks: [], careSetting: 'unknown', acuity: 'routine', ageGroup: 'unknown', eorRotations: [] },
    lifecycle: {
      status: 'draft',
      contentVersion: '0.0.0',
      reviews: [],
      nextReviewDue: '1970-01-01',
      openItems: ['Stored before the content package existed (schema 1.0).'],
      changeLog: [{ version: '0.0.0', date: '1970-01-01', summary: 'Pre-package snapshot.' }],
    },
  }
}
