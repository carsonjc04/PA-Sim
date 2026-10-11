import type { ReviewRating, ReviewState } from '../../src/domain/remediation/types'
import type { Scheduler } from './scheduler'

/**
 * Rebuilds a card's state from its append-only review log under a (possibly newer) scheduler.
 * Deterministic: each review stores its rating and time. Evidence added after the last review
 * (a repeat miss) pulls the due date forward, exactly as it did when it was recorded.
 */
export function replayCard(
  scheduler: Scheduler,
  createdAt: string,
  reviews: { rating: ReviewRating; reviewedAt: string }[],
  evidenceAt: string[] = [],
): ReviewState {
  const ordered = [...reviews].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))
  let state = scheduler.init(new Date(createdAt))
  for (const r of ordered) state = scheduler.review(state, r.rating, new Date(r.reviewedAt))
  const last = ordered.at(-1)?.reviewedAt
  const pulled = evidenceAt.filter((t) => !last || t > last).sort()[0]
  if (pulled && pulled < state.due) state = { ...state, due: pulled }
  return state
}
