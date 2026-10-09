import { Router } from 'express'
import type { AuthStatus } from '../../src/api/contracts'
import { authProvider } from '../auth/context'
import { insecureAuth, publicCapabilities } from '../config/env'
import { currentScenarios } from '../content/versions'
import { toPublicScenario } from '../attempts/projection'

export const router: Router = Router()

router.get('/ai/status', (_req, res) => {
  res.json(publicCapabilities())
})

router.get('/auth/status', async (req, res) => {
  const provider = authProvider()
  const auth = provider.available ? await provider.authenticate(req) : null
  const body: AuthStatus = {
    provider: provider.name,
    available: provider.available,
    insecure: insecureAuth,
    user: auth ? { displayName: auth.displayName } : null,
  }
  res.json(body)
})

router.get('/scenarios', (_req, res) => {
  res.json(currentScenarios().map(toPublicScenario))
})
