import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The e2e suite needs a live Immich and a deployed IPP; it has its own
    // config (vitest.e2e.config.ts) and `npm run test:e2e`.
    exclude: ['tests/e2e/**'],
    environment: 'node'
  }
})
