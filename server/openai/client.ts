import OpenAI from 'openai'
import { requireApiKey } from '../config/env'

let cached: OpenAI | null = null

/**
 * Created lazily so the server boots and serves guided mode with no key
 * configured. The key is read only here, at first use.
 */
export function openaiClient(): OpenAI {
  if (!cached) cached = new OpenAI({ apiKey: requireApiKey() })
  return cached
}

/** Test seam. */
export function setOpenAIClient(client: OpenAI | null): void {
  cached = client
}
