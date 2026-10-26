import { defineConfig } from '@playwright/test';

// Explicitly opt in: this suite creates synthetic Assets in the local dev stack.
export default defineConfig({
  testDir: './live-tests',
  timeout: 90000,
  use: {
    baseURL: 'http://localhost:8080',
    viewport: { width: 1440, height: 1000 },
  },
});
