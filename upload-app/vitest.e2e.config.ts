import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

/*
  End-to-end suite: runs against a REAL Immich and the real IPP and upload
  service containers (test/immich-stack.yml), so it is kept out of the default
  `npm test` run entirely rather than merely skipped there. See
  tests/e2e/helpers.ts for the environment contract.

  Single-threaded on purpose: the tests share one Immich album and assert on
  its contents, and the admission test wants the whole upload budget.
*/
export default defineConfig({
  resolve: {
    alias: { '@ipp/core': resolve(__dirname, '../shared/src/index.ts') }
  },
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
    maxWorkers: 1,
    // No retries: a flaky e2e is a signal, not noise to paper over
    retry: 0
  }
})
