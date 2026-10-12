import 'dotenv/config'
import './content/startup-check'
import { createApp } from './app'
import { aiEnabled, env, insecureAuth } from './config/env'
import { migrate } from './db/migrate'
import { getPool } from './db/pool'
import { resumeSessionGuards } from './live/sessionGuard'

const port = Number(process.env.PORT ?? env.PORT)

if (env.DATABASE_URL) {
  const applied = await migrate(getPool())
  console.log(`[server] database ready${applied.length ? `; applied migrations ${applied.join(', ')}` : ''}`)
} else {
  console.warn('[server] DATABASE_URL is not set; practice history endpoints will return 503')
}
if (env.DATABASE_URL && aiEnabled) {
  // Re-arm the server-side voice session limit after a restart; timers do not survive the process.
  const resumed = await resumeSessionGuards()
  if (resumed.armed || resumed.closed) console.log(`[server] voice session guard: ${resumed.armed} re-armed, ${resumed.closed} expired and closed`)
}
if (insecureAuth) {
  console.warn('[server] WARNING: AUTH_PROVIDER=dev in production. Any visitor can act as any user. Demo use only.')
}

const server = createApp().listen(port, '0.0.0.0', () => {
  console.log(`[server] listening on port ${port}`)
  console.log(`[server] AI voice mode: ${aiEnabled ? 'enabled' : 'disabled (no OPENAI_API_KEY)'}`)
  console.log(`[server] auth provider: ${env.AUTH_PROVIDER}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}