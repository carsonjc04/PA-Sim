import 'dotenv/config'
import { createApp } from './app'
import { aiEnabled, env } from './config/env'

const port = Number(process.env.PORT ?? env.PORT)

const server = createApp().listen(port, '0.0.0.0', () => {
  console.log(`[server] listening on port ${port}`)
  console.log(`[server] AI voice mode: ${aiEnabled ? 'enabled' : 'disabled (no OPENAI_API_KEY)'}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}