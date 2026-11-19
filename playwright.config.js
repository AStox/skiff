'use strict'
const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalTimeout: 15 * 60_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0 }
  },
  // Missing goldens must fail too. Only test:visual:update approves new images.
  updateSnapshots: 'none',
  snapshotPathTemplate: '{testDir}/goldens/{platform}-' + process.arch + '/{testFilePath}/{arg}{ext}',
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { actionTimeout: 8_000, navigationTimeout: 15_000, locale: 'en-US', timezoneId: 'UTC' }
})
