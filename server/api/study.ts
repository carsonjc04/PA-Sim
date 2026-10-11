import { Router } from 'express'
import type { ZodType } from 'zod'
import { sprintAnswerBody, studyPlanQuery } from '../../src/api/contracts'
import { authOf, requireAuth } from '../auth/context'
import { ApiError } from '../http/errors'
import * as service from '../study/service'

function parse<T>(schema: ZodType<T>, value: unknown, code: 'invalid_body' | 'invalid_query'): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    throw new ApiError(`Invalid request: ${detail}`, 400, code)
  }
  return parsed.data
}

export const studyRouter: Router = Router()

// Public: blueprint structure and honest coverage counts carry no learner data.
studyRouter.get('/taxonomy', (_req, res) => {
  res.json(service.publicTaxonomy())
})
studyRouter.get('/blueprints', (_req, res) => {
  res.json(service.listBlueprints())
})
studyRouter.get('/blueprints/:id/coverage', (req, res) => {
  res.json(service.coverageFor(String(req.params.id)))
})

// Personal: plans use the learner's attempts; sprints unlock per learner.
studyRouter.get('/plan', requireAuth, async (req, res) => {
  res.json(await service.studyPlan(authOf(req), parse(studyPlanQuery, req.query, 'invalid_query')))
})
studyRouter.get('/sprints', requireAuth, async (req, res) => {
  res.json(await service.listSprints(authOf(req)))
})
studyRouter.post('/sprints/:id/answer', requireAuth, async (req, res) => {
  const body = parse(sprintAnswerBody, req.body ?? {}, 'invalid_body')
  res.json(await service.answerSprint(authOf(req), String(req.params.id), body.optionId))
})
