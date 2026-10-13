import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.AISIGAME_TEST_PORT ?? 5173)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.play.ts',
  timeout: 60_000,
  fullyParallel: true,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    viewport: { width: 1366, height: 768 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
  },
})
