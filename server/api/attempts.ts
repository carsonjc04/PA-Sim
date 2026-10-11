import { Router, type Request } from 'express'
import type { ZodType } from 'zod'
import {
  attemptEventBody,
  historyQuery,
  idempotencyKeySchema,
  startAttemptBody,
  timeZoneSchema,
} from '../../src/api/contracts'
import { authOf, requireAuth } from '../auth/context'
import { ApiError } from '../http/errors'
import * as service from '../attempts/service'
import { attemptRemediation } from '../review/service'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parse<T>(schema: ZodType<T>, value: unknown, code: 'invalid_body' | 'invalid_query'): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    throw new ApiError(`Invalid request: ${detail}`, 400, code)
  }
  return parsed.data
}

function attemptIdOf(req: Request): string {
  const id = String(req.params.id)
  // A malformed ID is reported like a missing one, so probing reveals nothing.
  if (!uuidPattern.test(id)) throw new ApiError('Attempt not found.', 404, 'attempt_not_found')
  return id
}

export const attemptsRouter: Router = Router()
attemptsRouter.use(requireAuth)

attemptsRouter.post('/', async (req, res) => {
  const body = parse(startAttemptBody, req.body ?? {}, 'invalid_body')
  const started = await service.startAttempt(authOf(req), body.scenarioId)
  res.status(started.resumed ? 200 : 201).json(started)
})

attemptsRouter.get('/', async (req, res) => {
  const query = parse(historyQuery, req.query, 'invalid_query')
  res.json(await service.listHistory(authOf(req), query))
})

attemptsRouter.get('/:id', async (req, res) => {
  res.json(await service.getAttempt(authOf(req), attemptIdOf(req)))
})

attemptsRouter.post('/:id/events', async (req, res) => {
  const id = attemptIdOf(req)
  const key = req.get('Idempotency-Key')
  if (!key) throw new ApiError('An Idempotency-Key header is required.', 400, 'missing_idempotency_key')
  const parsedKey = parse(idempotencyKeySchema, key, 'invalid_body')
  const body = parse(attemptEventBody, req.body ?? {}, 'invalid_body')
  res.json(await service.recordEvent(authOf(req), id, `guided:${parsedKey}`, body, 'guided'))
})

attemptsRouter.post('/:id/submit', async (req, res) => {
  res.json(await service.submitAttempt(authOf(req), attemptIdOf(req)))
})

attemptsRouter.get('/:id/remediation', async (req, res) => {
  const id = attemptIdOf(req)
  const timeZone = req.query.timeZone === undefined ? undefined : parse(timeZoneSchema, req.query.timeZone, 'invalid_query')
  res.json(await attemptRemediation(authOf(req), id, timeZone))
})
