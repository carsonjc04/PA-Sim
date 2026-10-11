import {
  MICRO_SESSION_SIZE,
  type AttemptRemediation,
  type PublicReviewItem,
  type PublicReviewSession,
  type ReviewEventBody,
  type ReviewSessionResponse,
  type ReviewSummary,
  type StartReviewSessionBody,
  type SubmitReviewBody,
  type SubmitReviewResponse,
} from '../../src/api/contracts'
import type { ReviewPrompt, ReviewRating } from '../../src/domain/remediation/types'
import { dayEnd, isValidTimeZone, localDay } from '../../src/domain/review/day'
import { choosePrompt, describeDueReason } from '../../src/domain/review/reason'
import * as attempts from '../attempts/repository'
import { selectionsOf } from '../attempts/service'
import type { AuthContext } from '../auth/context'
import { canonicalJson, sha256 } from '../content/hash'
import { contentPackage } from '../content/scenarios'
import { getPool, withTransaction, type Queryable } from '../db/pool'
import { ApiError } from '../http/errors'
import { now } from '../lib/clock'
import { confidenceOf, deriveRemediation } from './derive'
import * as repo from './repository'
import { getScheduler, type Scheduler } from './scheduler'
import { replayCard } from './upgrade'

const DAY_MS = 86_400_000

function zoneOf(timeZone: string): string {
  if (!isValidTimeZone(timeZone)) throw new ApiError('Unknown time zone.', 400, 'invalid_time_zone')
  return timeZone
}

const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === '23505'

// ---- Content lookups (server-only: prompts and answers never ship in the bundle) ----

function kcLabel(kcId: string): string {
  return contentPackage().knowledge?.components.find((c) => c.id === kcId)?.label ?? kcId
}

function promptById(id: string): ReviewPrompt | undefined {
  for (const r of Object.values(contentPackage().remediation)) {
    const p = r.prompts.find((x) => x.id === id)
    if (p) return p
  }
  return undefined
}

/** Prompts for a knowledge component, drawn only from cases the user has submitted. */
function promptsFor(kcId: string, submitted: Set<string>): ReviewPrompt[] {
  return Object.values(contentPackage().remediation)
    .filter((r) => submitted.has(r.scenarioId))
    .flatMap((r) => r.prompts.filter((p) => p.kcId === kcId))
}

function isDraftContent(): boolean {
  const pkg = contentPackage()
  return pkg.knowledge?.provenance !== 'reviewed' || Object.values(pkg.remediation).some((r) => r.provenance !== 'reviewed')
}

// ---- Lazy maintenance: backfill and algorithm upgrades ----

async function backfill(q: Queryable, userId: string, at: Date): Promise<void> {
  for (const a of await repo.listUnderivedAttempts(q, userId)) {
    const scenario = await attempts.getContentDefinition(q, a.contentVersionId)
    const events = await attempts.listLiveEvents(q, a.id)
    await deriveRemediation(q, { attemptId: a.id, userId, scenarioId: a.scenarioId, scenario, selectedByPhase: selectionsOf(events), confidence: confidenceOf(events) }, at)
  }
}

/** Replays cards stamped with an older algorithm or parameters under the current scheduler. */
export async function upgradeStaleCards(q: Queryable, scheduler: Scheduler, at: Date, userId?: string): Promise<number> {
  const stale = await repo.listStaleCards(q, scheduler, userId)
  if (stale.length) await repo.ensureSchedulerParams(q, scheduler)
  for (const card of stale) {
    const review = replayCard(scheduler, card.createdAt, await repo.listCardReviews(q, card.id), await repo.listCardEvidenceTimes(q, card.id))
    await repo.updateCard(q, card.id, { review, scheduler, at })
  }
  return stale.length
}

async function prepare(q: Queryable, userId: string, at: Date): Promise<void> {
  await backfill(q, userId, at)
  await upgradeStaleCards(q, getScheduler(), at, userId)
}

async function lockUser(q: Queryable, userId: string): Promise<void> {
  await q.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId])
}

/** Due before the end of today's study day, with a prompt available, in queue order (oldest due first). */
async function dueQueue(q: Queryable, userId: string, timeZone: string, at: Date) {
  const day = localDay(at, timeZone)
  const cards = await repo.listDueCards(q, userId, dayEnd(day, timeZone))
  const submitted = await repo.submittedScenarioIds(q, userId)
  const queue: { card: repo.CardRow; prompt: ReviewPrompt }[] = []
  for (const card of cards) {
    const prompt = choosePrompt(promptsFor(card.kcId, submitted), card.lastPromptId, card.review.reps)
    if (prompt) queue.push({ card, prompt })
  }
  return { day, queue }
}

async function sessionView(q: Queryable, session: repo.SessionRow, timeZone: string): Promise<PublicReviewSession> {
  const cards = new Map((await repo.getCards(q, session.userId, session.cardIds)).map((c) => [c.id, c]))
  const sources = await repo.latestSources(q, session.cardIds)
  const items: PublicReviewItem[] = []
  session.cardIds.forEach((cardId, i) => {
    const card = cards.get(cardId)
    const prompt = promptById(session.promptIds[i])
    if (!card || !prompt) return
    const source = sources.get(cardId) ?? null
    items.push({
      cardId,
      status: i < session.position ? 'done' : i === session.position ? 'current' : 'upcoming',
      knowledgeLabel: kcLabel(card.kcId),
      prompt: { id: prompt.id, type: prompt.type, front: prompt.front, ...(prompt.choices ? { choices: prompt.choices } : {}) },
      answer: prompt.answer,
      explanation: prompt.explanation,
      reason: { code: card.dueReason.code, text: describeDueReason(card.dueReason, source, timeZone) },
      source: source ? { attemptId: source.attemptId, scenarioTitle: source.scenarioTitle, rubricItemId: source.rubricItemId, label: source.label } : null,
    })
  })
  return {
    id: session.id,
    localDay: session.localDay,
    mode: session.mode,
    position: session.position,
    total: session.cardIds.length,
    done: session.closedAt !== null || session.position >= session.cardIds.length,
    draftContent: isDraftContent(),
    items,
  }
}

// ---- Public operations ----

export async function startSession(auth: AuthContext, body: StartReviewSessionBody): Promise<ReviewSessionResponse> {
  const timeZone = zoneOf(body.timeZone)
  return withTransaction(getPool(), async (q) => {
    const at = now()
    await lockUser(q, auth.userId)
    await repo.setUserTimeZone(q, auth.userId, timeZone)
    await prepare(q, auth.userId, at)
    const { day, queue } = await dueQueue(q, auth.userId, timeZone, at)

    const open = await repo.getOpenSession(q, auth.userId, { forUpdate: true })
    if (open) {
      if (open.localDay === day && !body.restart) return { session: await sessionView(q, open, timeZone), resumed: true, dueToday: queue.length }
      await repo.closeSession(q, open.id, open.localDay === day ? 'restarted' : 'expired', at)
    }
    const chosen = body.mode === 'micro' ? queue.slice(0, MICRO_SESSION_SIZE) : queue
    if (chosen.length === 0) return { session: null, resumed: false, dueToday: 0 }

    const session = await repo.insertSession(q, {
      userId: auth.userId,
      localDay: day,
      timeZone,
      mode: body.mode,
      cardIds: chosen.map((x) => x.card.id),
      promptIds: chosen.map((x) => x.prompt.id),
      at,
    })
    const scheduler = getScheduler()
    for (const { card, prompt } of chosen) {
      await repo.insertLearningEvent(q, {
        userId: auth.userId,
        type: 'due',
        cardId: card.id,
        sessionId: session.id,
        promptType: prompt.type,
        retrievability: scheduler.retrievability(card.review, at),
        at,
      })
    }
    return { session: await sessionView(q, session, timeZone), resumed: false, dueToday: queue.length }
  })
}

/** The open session for today's study day, for resuming after a refresh or interruption. Read-only. */
export async function currentSession(auth: AuthContext, timeZone: string): Promise<ReviewSessionResponse> {
  const zone = zoneOf(timeZone)
  return withTransaction(getPool(), async (q) => {
    const at = now()
    await prepare(q, auth.userId, at)
    const { day, queue } = await dueQueue(q, auth.userId, zone, at)
    const open = await repo.getOpenSession(q, auth.userId)
    if (!open || open.localDay !== day) return { session: null, resumed: false, dueToday: queue.length }
    return { session: await sessionView(q, open, open.timeZone), resumed: true, dueToday: queue.length }
  })
}

export async function summary(auth: AuthContext, timeZone: string): Promise<ReviewSummary> {
  const zone = zoneOf(timeZone)
  return withTransaction(getPool(), async (q) => {
    const at = now()
    await prepare(q, auth.userId, at)
    const { day, queue } = await dueQueue(q, auth.userId, zone, at)
    return { localDay: day, dueToday: queue.length, totalCards: await repo.countCards(q, auth.userId) }
  })
}

/**
 * Records one rating. A repeated idempotency key with the same body returns the stored response;
 * a different body is a conflict. Only the session's current item can be rated.
 */
export async function recordReview(auth: AuthContext, cardId: string, key: string, body: SubmitReviewBody): Promise<SubmitReviewResponse> {
  const requestHash = sha256(canonicalJson({ cardId, body }))
  const replay = async (q: Queryable) => {
    const prior = await repo.getReviewByKey(q, auth.userId, key)
    if (!prior) return null
    if (prior.requestHash !== requestHash) throw new ApiError('This Idempotency-Key was already used for a different review.', 409, 'idempotency_conflict')
    return prior.response as SubmitReviewResponse
  }
  try {
    return await withTransaction(getPool(), async (q) => {
      const at = now()
      const card = await repo.getOwnedCard(q, auth.userId, cardId, { forUpdate: true })
      if (!card) throw new ApiError('Review item not found.', 404, 'review_card_not_found')
      const prior = await replay(q)
      if (prior) return prior

      const session = await repo.getOwnedSession(q, auth.userId, body.sessionId, { forUpdate: true })
      if (!session) throw new ApiError('Review session not found.', 404, 'review_session_not_found')
      if (session.closedAt || session.cardIds[session.position] !== cardId || session.promptIds[session.position] !== body.promptId) {
        throw new ApiError('This item is not the current one in your review session. Reload to continue.', 409, 'review_out_of_order')
      }
      const prompt = promptById(body.promptId)
      if (!prompt) throw new ApiError('Review item not found.', 404, 'review_card_not_found')

      const scheduler = getScheduler()
      await repo.ensureSchedulerParams(q, scheduler)
      let before = card.review
      if (card.algorithmVersion !== scheduler.algorithmVersion || card.paramsId !== scheduler.paramsId) {
        before = replayCard(scheduler, card.createdAt, await repo.listCardReviews(q, card.id), await repo.listCardEvidenceTimes(q, card.id))
      }
      const rating = body.rating as ReviewRating
      const after = scheduler.review(before, rating, at)
      const stamp = at.toISOString()
      await repo.updateCard(q, card.id, { review: after, scheduler, dueReason: { code: 'scheduled', at: stamp, lastReviewedAt: stamp }, lastPromptId: prompt.id, at })

      const position = session.position + 1
      const done = position >= session.cardIds.length
      await repo.advanceSession(q, session.id, position)
      if (done) await repo.closeSession(q, session.id, 'finished', at)

      const response: SubmitReviewResponse = {
        cardId,
        rating,
        nextDue: after.due,
        nextDueInDays: Math.max(0, Math.round((Date.parse(after.due) - at.getTime()) / DAY_MS)),
        session: { id: session.id, position, total: session.cardIds.length, done },
      }
      await repo.insertReview(q, {
        userId: auth.userId,
        cardId,
        sessionId: session.id,
        promptId: prompt.id,
        promptType: prompt.type,
        rating,
        latencyMs: body.latencyMs ?? null,
        at,
        before,
        after,
        scheduler,
        key,
        requestHash,
        response,
      })

      const reviewedBefore = before.lastReview !== null
      const elapsedDays = reviewedBefore ? (at.getTime() - Date.parse(before.lastReview!)) / DAY_MS : null
      const retrievability = scheduler.retrievability(before, at)
      const common = { userId: auth.userId, cardId, sessionId: session.id, promptType: prompt.type, at }
      await repo.insertLearningEvent(q, { ...common, type: 'rated', rating, latencyMs: body.latencyMs ?? null, elapsedDays, retrievability })
      // Retention outcome: only meaningful once the card has been reviewed before.
      if (reviewedBefore) await repo.insertLearningEvent(q, { ...common, type: 'retention', rating, elapsedDays, retrievability, recalled: rating > 1 })
      return response
    })
  } catch (error) {
    // Two concurrent requests with the same key: the loser returns the winner's stored response.
    if (!isUniqueViolation(error)) throw error
    const prior = await replay(getPool())
    if (!prior) throw error
    return prior
  }
}

/** Client-observed moments (prompt shown, answer revealed). Idempotent per card per session. */
export async function recordReviewEvent(auth: AuthContext, sessionId: string, body: ReviewEventBody): Promise<{ ok: true }> {
  const pool = getPool()
  const session = await repo.getOwnedSession(pool, auth.userId, sessionId)
  if (!session) throw new ApiError('Review session not found.', 404, 'review_session_not_found')
  const index = session.cardIds.indexOf(body.cardId)
  if (index < 0) throw new ApiError('Review item not found.', 404, 'review_card_not_found')
  await repo.insertLearningEvent(pool, {
    userId: auth.userId,
    type: body.type,
    cardId: body.cardId,
    sessionId,
    promptType: promptById(session.promptIds[index])?.type ?? null,
    latencyMs: body.type === 'answered' ? (body.latencyMs ?? null) : null,
    at: now(),
  })
  return { ok: true }
}

/** Per-miss remediation state for a submitted attempt. Refused before submission so nothing leaks mid-case. */
export async function attemptRemediation(auth: AuthContext, attemptId: string, timeZone?: string): Promise<AttemptRemediation> {
  const zone = timeZone ? zoneOf(timeZone) : 'UTC'
  return withTransaction(getPool(), async (q) => {
    const at = now()
    const attempt = await attempts.getOwnedAttempt(q, auth.userId, attemptId)
    if (!attempt) throw new ApiError('Attempt not found.', 404, 'attempt_not_found')
    if (attempt.status !== 'submitted') throw new ApiError('Submit the encounter to see its review plan.', 409, 'attempt_not_submitted')
    if (!(await repo.isDerived(q, attempt.id))) await prepare(q, auth.userId, at)

    const end = dayEnd(localDay(at, zone), zone).getTime()
    const authored = contentPackage().remediation[attempt.scenarioId]
    const evidence = await repo.listAttemptEvidence(q, attempt.id)
    return {
      attemptId: attempt.id,
      authored: Boolean(authored),
      draftContent: authored ? authored.provenance !== 'reviewed' : false,
      items: evidence.map((e) => ({
        rubricItemId: e.rubricItemId,
        label: e.label,
        kind: e.kind,
        errorType: e.errorType,
        status: e.status,
        cards: e.cards.map((c) => ({ cardId: c.cardId, knowledgeLabel: kcLabel(c.kcId), due: c.due, dueToday: Date.parse(c.due) < end })),
      })),
    }
  })
}
