import { Router } from 'express'
import { analyticsDashboardQuery } from '../../src/api/contracts'
import * as service from '../analytics/service'
import { authOf, requireAuth } from '../auth/context'
import { ApiError } from '../http/errors'

export const analyticsRouter: Router = Router()

// Personal: computed from the learner's own stored events. Never shown to anyone else.
analyticsRouter.get('/dashboard', requireAuth, async (req, res) => {
  const parsed = analyticsDashboardQuery.safeParse(req.query)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ')
    throw new ApiError(`Invalid request: ${detail}`, 400, 'invalid_query')
  }
  res.json(await service.dashboard(authOf(req), parsed.data))
})
