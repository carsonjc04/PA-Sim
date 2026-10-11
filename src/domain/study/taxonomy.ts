import type { TaxonomyTerm, TaxonomyVocabulary } from '../schema'
import type { Taxonomy } from '../types'

/** The tag fields coverage and filtering read. Built from a case's taxonomy (current or a stored snapshot). */
export interface ItemTags {
  organSystems: string[]
  panceTasks: string[]
  topicTags: string[]
  careSettings: string[]
  ageGroups: string[]
  eorRotations: string[]
}

/**
 * Maps deprecated IDs to their replacements, following chains. Unknown IDs are kept unchanged so a stored
 * snapshot never silently loses a tag; the validator stops unknown IDs from shipping in current content.
 */
export function resolveTerms(ids: readonly string[], terms: readonly TaxonomyTerm[]): string[] {
  const byId = new Map(terms.map((t) => [t.id, t]))
  const out: string[] = []
  const visit = (id: string, seen: Set<string>) => {
    const term = byId.get(id)
    if (term?.status === 'deprecated' && term.replacedBy && !seen.has(id)) {
      seen.add(id)
      for (const next of term.replacedBy) visit(next, seen)
      return
    }
    if (!out.includes(id)) out.push(id)
  }
  for (const id of ids) visit(id, new Set())
  return out
}

/** Canonical tags for a taxonomy block. Reads only; the stored taxonomy is never rewritten. */
export function canonicalTags(t: Pick<Taxonomy, 'organSystems' | 'panceTasks' | 'eorRotations' | 'careSetting' | 'ageGroup'> & { topicTags?: string[] }, vocab: TaxonomyVocabulary): ItemTags {
  return {
    organSystems: resolveTerms(t.organSystems, vocab.organSystems),
    panceTasks: resolveTerms(t.panceTasks, vocab.panceTasks),
    topicTags: resolveTerms(t.topicTags ?? [], vocab.topicTags),
    careSettings: resolveTerms([t.careSetting], vocab.careSettings),
    ageGroups: resolveTerms([t.ageGroup], vocab.ageGroups),
    eorRotations: resolveTerms(t.eorRotations, vocab.eorRotations),
  }
}

export const activeTerms = (terms: readonly TaxonomyTerm[]) => terms.filter((t) => t.status === 'active')
