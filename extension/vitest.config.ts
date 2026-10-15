import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests don't load the CRXJS plugin.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/chrome.ts'],
  },
});
