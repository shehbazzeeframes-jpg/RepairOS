import { defineConfig, devices } from '@playwright/test';

/**
 * Real-stack QA suite (Sprint 1 onwards). No page.route mocks: the browser drives the built web app,
 * which proxies /api to the real NestJS API, Postgres, Redis/BullMQ worker and the file outbox.
 *
 * Start the stack yourself first (see docs/qa/sprint1.md "How to run"), then:
 *   pnpm --filter @repairos/e2e test:real
 *
 * global-setup truncates and re-seeds the database named in the repo-root .env (DATABASE_URL), so point
 * that at a throwaway database. Tests share one database and run serially (workers: 1).
 */
const baseURL = process.env.REAL_BASE_URL ?? 'http://localhost:3200';

export default defineConfig({
  testDir: './real',
  testMatch: /.*\.real\.ts$/,
  globalSetup: './real/support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/real-results.json' }]],
  outputDir: 'test-results/real',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
});
