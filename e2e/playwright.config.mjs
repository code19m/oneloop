import { availableParallelism } from 'node:os';
import { defineConfig } from '@playwright/test';

const ci = !!process.env.CI;

// Every test starts its own server, so tests run fully in parallel. Each worker
// is a browser plus a server; the harness has ports for up to ten workers.
export default defineConfig({
  testDir: './journeys',
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0,
  workers: ci ? 2 : Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2))),
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: ci
    ? [['list'], ['html', { open: 'never', outputFolder: '../target/e2e-report' }]]
    : [['list']],
  outputDir: '../target/e2e-results',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        // The app sends Cross-Origin-Opener-Policy: same-origin. Firefox then
        // moves the first navigation into a new browsing context group, and
        // under load Playwright can lose that navigation and never see it
        // commit. Keep Firefox in one group; the header itself is still sent
        // and checked by the startup journey.
        launchOptions: { firefoxUserPrefs: { 'browser.tabs.remote.useCrossOriginOpenerPolicy': false } },
      },
    },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  use: {
    headless: true,
    viewport: { width: 1440, height: 960 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
});
