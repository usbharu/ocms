import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  // API mocks must reach Playwright rather than an active service worker.
  use: { ...base.use, serviceWorkers: 'block' },
  testMatch: [
    'routing.spec.ts',
    'personal-recommendations.spec.ts',
    'recommendations.spec.ts',
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
});
