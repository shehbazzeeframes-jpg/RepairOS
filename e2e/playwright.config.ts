import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Every /api/** call is mocked with page.route (see tests/support/mock-api.ts), so the
 * web app runs on its own. API_URL points at a closed port so an unmocked call fails loudly.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'off',
    deviceScaleFactor: 1,
    // Astryx skips its enter/exit animations, so clicks never race a moving popover (BK2).
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /screenshots\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: 'screenshots',
      testMatch: /screenshots\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm --filter @repairos/web build && pnpm --filter @repairos/web exec next start --port ${PORT}`,
        url: `${baseURL}/sign-in`,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        env: {
          API_URL: 'http://127.0.0.1:9',
          NEXT_DIST_DIR: '.next-e2e',
          NEXT_TELEMETRY_DISABLED: '1',
          // The dev outbox page is a 404 in production builds; the e2e build opts in.
          NEXT_PUBLIC_DEV_OUTBOX: '1',
        },
      },
});
