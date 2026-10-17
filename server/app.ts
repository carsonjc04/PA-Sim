import { randomUUID } from 'node:crypto'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import { analyticsRouter } from './api/analytics'
import { attemptsRouter } from './api/attempts'
import { liveRouter } from './api/live'
import { reviewRouter } from './api/review'
import { router } from './api/routes'
import { studyRouter } from './api/study'
import { insecureAuthHeader } from './auth/context'
import { env } from './config/env'
import { ApiError } from './http/errors'

export function createApp() {
  const app = express()
  // req.ip keys the voice rate limit and the session ledger's per-address checks; behind a proxy it must be the client.
  if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS)

  app.use((req, _res, next) => {
    ;(req as Request & { requestId: string }).requestId = randomUUID()
    next()
  })
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: false,
      allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Dev-User'],
      exposedHeaders: ['X-ClinicSim-Insecure-Auth'],
    }),
  )
  app.use(express.json({ limit: '256kb' }))
  app.use(insecureAuthHeader)

  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  app.use('/api/live', liveRouter)
  app.use('/api/attempts', attemptsRouter)
  app.use('/api/review', reviewRouter)
  app.use('/api/study', studyRouter)
  app.use('/api/analytics', analyticsRouter)
  app.use('/api', router)

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } })
  })

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as Request & { requestId?: string }).requestId
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, requestId }, ...(err.extra ?? {}) })
      return
    }
    // express.json() rejects malformed JSON before any route runs.
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_body', message: 'Request body is not valid JSON.', requestId } })
      return
    }
    if ((err as { type?: string })?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'invalid_body', message: 'Request body is too large.', requestId } })
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
