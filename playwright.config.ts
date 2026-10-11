import { defineConfig, devices } from '@playwright/test'

// End-to-end and accessibility checks against a real server and browser. Opt-in: `npm run test:e2e`.
// Needs Postgres (`npm run db:up`). Uses its own ports and the test database, and runs with AI voice
// disabled so every journey must work in guided mode.
const API_PORT = 8788
const WEB_PORT = 5180
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://clinicsim:clinicsim@127.0.0.1:5442/clinicsim_test'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx server/index.ts',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        CLIENT_ORIGIN: `http://localhost:${WEB_PORT}`,
        DATABASE_URL: TEST_DATABASE_URL,
        AUTH_PROVIDER: 'dev',
        NODE_ENV: 'development',
        OPENAI_API_KEY: '',
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_BASE_URL: `http://localhost:${API_PORT}` },
    },
  ],
})
