import type { NextFunction, Request, Response } from 'express'
import { devUserSchema } from '../../src/api/contracts'
import { env, insecureAuth } from '../config/env'
import { getPool } from '../db/pool'
import { ApiError } from '../http/errors'
import { upsertUser } from '../attempts/repository'

export interface AuthContext {
  userId: string
  provider: 'dev'
  displayName: string
}

/** A real provider (OIDC, session cookie) implements this; routes only see AuthContext. */
export interface AuthProvider {
  readonly name: 'dev' | 'none'
  readonly available: boolean
  authenticate(req: Request): Promise<AuthContext | null>
}

export const DEV_USER_HEADER = 'x-dev-user'

/** Development only: anyone can claim any name. Never treat this as authentication. */
export const devAuthProvider: AuthProvider = {
  name: 'dev',
  available: true,
  async authenticate(req) {
    const raw = req.get(DEV_USER_HEADER)
    if (!raw) return null
    const parsed = devUserSchema.safeParse(raw)
    if (!parsed.success) throw new ApiError('X-Dev-User must be 2-32 lowercase letters, digits, ".", "_" or "-".', 400, 'invalid_body')
    const user = await upsertUser(getPool(), 'dev', parsed.data, parsed.data)
    return { userId: user.id, provider: 'dev', displayName: user.displayName }
  },
}

export const noAuthProvider: AuthProvider = {
  name: 'none',
  available: false,
  async authenticate() {
    return null
  },
}

let active: AuthProvider = env.AUTH_PROVIDER === 'dev' ? devAuthProvider : noAuthProvider

export function authProvider(): AuthProvider {
  return active
}

/** Test seam. */
export function setAuthProvider(provider: AuthProvider): void {
  active = provider
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext
  }
}

export function insecureAuthHeader(_req: Request, res: Response, next: NextFunction) {
  if (insecureAuth) res.setHeader('X-ClinicSim-Insecure-Auth', 'dev-provider')
  next()
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const provider = authProvider()
    if (!provider.available) {
      throw new ApiError('Sign-in is not available on this server yet, so practice history cannot be saved.', 401, 'auth_unavailable')
    }
    const auth = await provider.authenticate(req)
    if (!auth) throw new ApiError('Choose a user before practicing.', 401, 'auth_required')
    req.auth = auth
    next()
  } catch (error) {
    next(error)
  }
}

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw new ApiError('Choose a user before practicing.', 401, 'auth_required')
  return req.auth
}
