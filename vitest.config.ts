import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Set before modules load: server/config/env.ts reads the environment once.
    env: {
      NODE_ENV: 'test',
      AUTH_PROVIDER: 'dev',
      DATABASE_URL: '',
      OPENAI_API_KEY: '',
    },
  },
})
