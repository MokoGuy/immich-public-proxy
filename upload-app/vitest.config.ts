import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Test against core's source, so `npm test` needs no build of shared/
    alias: { '@ipp/core': resolve(__dirname, '../shared/src/index.ts') }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Need a live Immich: `npm run test:e2e` and `npm run test:browser`
    exclude: ['tests/e2e/**', 'tests/browser/**', '**/node_modules/**'],
    environment: 'node'
  }
})
