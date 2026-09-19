import { createApp } from './app'
import { aiEnabled, env } from './config/env'

const server = createApp().listen(env.PORT, () => {
  console.log(`[server] listening on http://localhost:${env.PORT}`)
  console.log(`[server] AI voice mode: ${aiEnabled ? 'enabled' : 'disabled (no OPENAI_API_KEY)'}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
