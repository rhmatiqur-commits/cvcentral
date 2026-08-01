// CV Central — Playwright smoke-test config.
//
// Runs against production (BASE_URL) by default, since there's no staging
// environment. Tests are written to be non-destructive: no real payments,
// no real Anthropic calls (the AI response is mocked via page.route in the
// authenticated flow test), and the authenticated tests only run at all if
// TEST_USER_EMAIL / TEST_USER_PASSWORD are provided — see TESTING.md.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false, // be gentle on production — run serially
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://cvcentral.io',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
});
