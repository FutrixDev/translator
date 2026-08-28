// @ts-check
const { defineConfig } = require('@playwright/test');
const path = require('path');

/**
 * Playwright configuration for Blab Translation Chrome Extension testing
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './test/e2e',

  // Run tests in parallel
  fullyParallel: false, // Extensions need sequential execution

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Limit workers for extension testing
  workers: 1,

  // Reporter to use
  reporter: [
    ['html', { outputFolder: 'test/reports' }],
    ['list'],
  ],

  // Shared settings for all the projects below
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    // baseURL: 'http://localhost:3000',

    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video recording
    video: 'retain-on-failure',
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium-extension',
      use: {
        // Chrome extension testing requires specific setup
        // See test/e2e/fixtures.js for extension loading
      },
    },
  ],

  // Global timeout
  timeout: 60000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },

  // Output folder for test artifacts
  outputDir: 'test/results',
});
