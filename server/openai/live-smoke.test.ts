import { describe, expect, it } from 'vitest'

/**
 * Opt-in and billable. Skipped unless RUN_OPENAI_LIVE_SMOKE=1 and a key are
 * present, so `npm test` never contacts OpenAI.
 *
 * This does not open a Live session: live.create needs a real SDP offer, which
 * only a browser can produce. It verifies the credential and that the installed
 * SDK exposes the Live surface. The end-to-end voice check is manual — see the
 * first-live-test steps in README.md.
 */
const enabled = process.env.RUN_OPENAI_LIVE_SMOKE === '1' && Boolean(process.env.OPENAI_API_KEY)

describe.skipIf(!enabled)('OpenAI live smoke (billable)', () => {
  it('authenticates and exposes the Live API', async () => {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const models = await client.models.list()
    expect(models).toBeTruthy()
    expect(typeof client.live.create).toBe('function')
  }, 30_000)
})
