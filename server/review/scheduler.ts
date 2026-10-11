import { FSRSVersion, State, createEmptyCard, fsrs, generatorParameters, type Card, type FSRSParameters, type Grade } from 'ts-fsrs'
import type { ReviewRating, ReviewState } from '../../src/domain/remediation/types'
import { canonicalJson, sha256 } from '../content/hash'

/**
 * Spaced-review scheduling behind an interface, so the algorithm can be replaced or upgraded
 * without touching storage or the API. Implementations must be deterministic: the same state,
 * rating and time always give the same next state.
 */
export interface Scheduler {
  /** Stored with every card and review. Changing it triggers a replay of the card's review log. */
  readonly algorithmVersion: string
  /** Short hash of the parameters, stored with every card and review. */
  readonly paramsId: string
  readonly params: Readonly<Record<string, unknown>>
  /** A card that has never been reviewed, due immediately. */
  init(now: Date): ReviewState
  review(state: ReviewState, rating: ReviewRating, now: Date): ReviewState
  /** Probability of recall at `now` (0–1); 0 for a card never reviewed. */
  retrievability(state: ReviewState, now: Date): number
}

/** Pinned with the exact ts-fsrs release in package.json. A test fails if they drift. */
export const TS_FSRS_RELEASE = '5.4.2'
export const FSRS_ALGORITHM_VERSION = `fsrs-6/ts-fsrs@${TS_FSRS_RELEASE}`

/**
 * Parameter choices (documented in docs/remediation.md):
 * - fuzz off: deterministic and testable; no random interval spread.
 * - short-term steps off: the queue is daily, so "Got it" schedules days ahead rather than 10 minutes.
 * - maximum interval one year: a PA program horizon, not a lifetime.
 * Default FSRS-6 weights and 90% requested retention otherwise.
 */
export const DEFAULT_FSRS_PARAMS: FSRSParameters = generatorParameters({
  enable_fuzz: false,
  enable_short_term: false,
  maximum_interval: 365,
  request_retention: 0.9,
})

function toCard(s: ReviewState): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: 0,
    scheduled_days: s.scheduledDays,
    learning_steps: s.learningSteps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as State,
    ...(s.lastReview ? { last_review: new Date(s.lastReview) } : {}),
  }
}

function fromCard(c: Card): ReviewState {
  return {
    state: c.state as ReviewState['state'],
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    lastReview: c.last_review ? c.last_review.toISOString() : null,
  }
}

export function createFsrsScheduler(params: FSRSParameters = DEFAULT_FSRS_PARAMS): Scheduler {
  const engine = fsrs(params)
  const plain = { ...params, w: [...params.w], learning_steps: [...params.learning_steps], relearning_steps: [...params.relearning_steps] }
  return {
    algorithmVersion: FSRS_ALGORITHM_VERSION,
    paramsId: sha256(canonicalJson(plain)).slice(0, 12),
    params: plain,
    init: (now) => fromCard(createEmptyCard(now)),
    review: (state, rating, now) => fromCard(engine.next(toCard(state), now, rating as Grade).card),
    retrievability: (state, now) => (state.state === State.New ? 0 : engine.get_retrievability(toCard(state), now, false)),
  }
}

let current: Scheduler | undefined

/** The scheduler new reviews use. Cards stamped with another version or parameters are replayed under it. */
export function getScheduler(): Scheduler {
  current ??= createFsrsScheduler()
  return current
}

/** Test seam for simulating an algorithm or parameter upgrade. Pass null to restore the default. */
export function setSchedulerForTests(next: Scheduler | null): void {
  current = next ?? undefined
}

export { FSRSVersion }
