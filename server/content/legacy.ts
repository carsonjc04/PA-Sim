import type { ScenarioDefinition, Suitability } from '../../src/domain/types'

/** Placeholder for snapshots that predate suitability. Read-only history; never shown as a recommendation. */
const LEGACY_SUITABILITY: Suitability = { modes: ['osce'], learnerLevel: 'both', estMinutes: 1, voiceReady: false }

/**
 * Snapshots stored before schema 2.0 have no lifecycle, taxonomy or waivers. This adapter fills
 * the missing administrative fields at read time so old attempts still render and grade; it never
 * rewrites the stored snapshot, and grading reads only fields that already existed in v1.
 */
export function upgradeStoredDefinition(stored: unknown): ScenarioDefinition {
  const d = stored as Partial<ScenarioDefinition> & { reviewStatus?: string }
  if (d.lifecycle && d.taxonomy) {
    // Snapshots stored before suitability existed. Tag IDs are left as stored; study code resolves deprecated IDs when it reads them.
    if (!d.taxonomy.suitability) return { ...(d as ScenarioDefinition), taxonomy: { ...d.taxonomy, suitability: LEGACY_SUITABILITY } }
    return d as ScenarioDefinition
  }
  const references = (d.clinicalReferences ?? []).map((r) => {
    const legacy = r as { title: string; organization: string; url: string; reviewed?: string }
    return { title: legacy.title, organization: legacy.organization, url: legacy.url, accessedAt: legacy.reviewed ?? '1970-01-01', specificity: 'general' as const, verified: false }
  })
  return {
    ...(d as ScenarioDefinition),
    clinicalReferences: references,
    criticalWaivers: d.criticalWaivers ?? [],
    spoilerTerms: d.spoilerTerms ?? [],
    taxonomy: { provenance: 'author-proposed-unreviewed', organSystems: [], panceTasks: [], careSetting: 'unknown', acuity: 'routine', ageGroup: 'unknown', eorRotations: [], suitability: LEGACY_SUITABILITY },
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
