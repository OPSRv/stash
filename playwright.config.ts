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
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
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
