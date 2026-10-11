import { Router, type Request } from 'express'
import type { ZodType } from 'zod'
import { idempotencyKeySchema, reviewEventBody, startReviewSessionBody, submitReviewBody, timeZoneQuery } from '../../src/api/contracts'
import { authOf, requireAuth } from '../auth/context'
import { ApiError } from '../http/errors'
import * as service from '../review/service'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parse<T>(schema: ZodType<T>, value: unknown, code: 'invalid_body' | 'invalid_query'): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    throw new ApiError(`Invalid request: ${detail}`, 400, code)
  }
  return parsed.data
}

function idOf(req: Request, code: 'review_card_not_found' | 'review_session_not_found'): string {
  const id = String(req.params.id)
  // A malformed ID is reported like a missing one, so probing reveals nothing.
  if (!uuidPattern.test(id)) throw new ApiError('Not found.', 404, code)
  return id
}

export const reviewRouter: Router = Router()
reviewRouter.use(requireAuth)

reviewRouter.get('/summary', async (req, res) => {
  const { timeZone } = parse(timeZoneQuery, req.query, 'invalid_query')
  res.json(await service.summary(authOf(req), timeZone))
})

reviewRouter.post('/sessions', async (req, res) => {
  res.json(await service.startSession(authOf(req), parse(startReviewSessionBody, req.body ?? {}, 'invalid_body')))
})

reviewRouter.get('/sessions/current', async (req, res) => {
  const { timeZone } = parse(timeZoneQuery, req.query, 'invalid_query')
  res.json(await service.currentSession(authOf(req), timeZone))
})

reviewRouter.post('/sessions/:id/events', async (req, res) => {
  const id = idOf(req, 'review_session_not_found')
  res.json(await service.recordReviewEvent(authOf(req), id, parse(reviewEventBody, req.body ?? {}, 'invalid_body')))
})

reviewRouter.post('/cards/:id/reviews', async (req, res) => {
  const id = idOf(req, 'review_card_not_found')
  const key = req.get('Idempotency-Key')
  if (!key) throw new ApiError('An Idempotency-Key header is required.', 400, 'missing_idempotency_key')
  const parsedKey = parse(idempotencyKeySchema, key, 'invalid_body')
  res.json(await service.recordReview(authOf(req), id, parsedKey, parse(submitReviewBody, req.body ?? {}, 'invalid_body')))
})
