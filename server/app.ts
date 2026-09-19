import { randomUUID } from 'node:crypto'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { liveRouter } from './api/live'
import { router } from './api/routes'
import { env } from './config/env'
import { EncounterError } from './encounters/store'

export function createApp() {
  const app = express()

  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: false }))
  app.use(express.json({ limit: '256kb' }))

  app.use((req, _res, next) => {
    ;(req as Request & { requestId: string }).requestId = randomUUID()
    next()
  })

  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  app.use('/api/live', liveRouter)
  app.use('/api', router)

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } })
  })

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as Request & { requestId?: string }).requestId
    if (err instanceof EncounterError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } })
      return
    }
    // Internal detail is logged, never returned, so provider or stack text
    // cannot reach the student.
    console.error('[server] unhandled error', { requestId, err })
    res.status(500).json({
      error: { code: 'internal_error', message: 'Something went wrong.', requestId },
    })
  })

  return app
}
