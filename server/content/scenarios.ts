import { env } from '../config/env'
import { DEFAULT_CONTENT_DIR } from './loader'
import { loadContent, type LoadedContent } from './package'

let cached: LoadedContent | undefined

/**
 * The validated content package, loaded once. Production and the build use strict locking.
 * CONTENT_DIR is honoured outside production only, so tests can point at a broken package.
 */
export function contentPackage(): LoadedContent {
  if (!cached) {
    const dir = env.NODE_ENV !== 'production' && process.env.CONTENT_DIR ? process.env.CONTENT_DIR : DEFAULT_CONTENT_DIR
    cached = loadContent(dir, { strict: env.NODE_ENV === 'production' })
  }
  return cached
}

export function resetContentCacheForTests(): void {
  cached = undefined
}

/** The validated cases. Loading is eager, so importing this module with an invalid package throws. */
export const scenarios: LoadedContent['scenarios'] = contentPackage().scenarios
