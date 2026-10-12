import type { Interval, Sufficiency } from './types'

/**
 * Evidence tiers for case-based rates. Product heuristics, not validated thresholds; review with a PA educator.
 * The unit is a submitted attempt. A single case counts at most as `insufficient`, however often it is replayed,
 * so one good (or bad) case can never read as a settled strength or weakness.
 */
export const CASE_TIERS = { limitedAttempts: 3, limitedCases: 2, adequateAttempts: 6, adequateCases: 3 } as const

/** Evidence tiers for retrieval rates. The unit is a review of a previously seen card. */
export const REVIEW_TIERS = { limitedReviews: 5, limitedCards: 2, adequateReviews: 20, adequateCards: 5 } as const

/** Interval shown around a rate. 80% keeps intervals readable at small n without implying precision. */
export const INTERVAL_LEVEL = 0.8
const Z_80 = 1.2815515655446004

export function caseSufficiency(attempts: number, distinctCases: number): Sufficiency {
  if (attempts <= 0) return 'none'
  if (attempts >= CASE_TIERS.adequateAttempts && distinctCases >= CASE_TIERS.adequateCases) return 'adequate'
  if (attempts >= CASE_TIERS.limitedAttempts && distinctCases >= CASE_TIERS.limitedCases) return 'limited'
  return 'insufficient'
}

export function reviewSufficiency(reviews: number, distinctCards: number): Sufficiency {
  if (reviews <= 0) return 'none'
  if (reviews >= REVIEW_TIERS.adequateReviews && distinctCards >= REVIEW_TIERS.adequateCards) return 'adequate'
  if (reviews >= REVIEW_TIERS.limitedReviews && distinctCards >= REVIEW_TIERS.limitedCards) return 'limited'
  return 'insufficient'
}

export const showsValue = (s: Sufficiency) => s === 'limited' || s === 'adequate'

/** Wilson score interval for successes/n at the 80% level. Null when n is 0. */
export function wilson(successes: number, n: number): Interval | null {
  if (n <= 0) return null
  const p = successes / n
  const z2 = Z_80 * Z_80
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (Z_80 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  const round = (x: number) => Math.round(x * 1000) / 1000
  return { low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)), level: INTERVAL_LEVEL }
}
