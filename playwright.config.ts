import { defineConfig, devices } from '@playwright/test';

/**
 * Minimal Playwright config that drives the Vite dev server. This covers
 * UI interactions that don't hit Tauri's IPC (component layout, keyboard
 * nav, overlays). True end-to-end runs against the packaged app via
 * tauri-driver are intentionally out of scope for this scaffold.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [['list']],
  // CI machines are slower than dev laptops and the dev server boot
  // race occasionally drops one frame on the first try. Two retries
  // there keeps the suite reliable; locally we still want zero so
  // a failing assertion gets noticed instead of papered over.
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:1420',
    // Keep the trace artifact whenever a test fails so the CI run
    // bundles the timeline + DOM snapshots — much faster to triage
    // than re-running the suite locally.
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
