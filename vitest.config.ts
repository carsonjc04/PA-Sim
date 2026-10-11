import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Playwright owns e2e/; Vitest must not collect its *.spec.ts files.
    exclude: ['**/node_modules/**', 'e2e/**'],
    // Set before modules load: server/config/env.ts reads the environment once.
    env: {
      NODE_ENV: 'test',
      AUTH_PROVIDER: 'dev',
      DATABASE_URL: '',
      OPENAI_API_KEY: '',
    },
  },
})
