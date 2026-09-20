import { defineConfig } from 'vitest/config'

/*
 End-to-end suite: runs against a REAL Immich and a REAL deployed IPP, so it
 is kept out of the default `npm test` run entirely rather than merely being
 skipped there. See tests/e2e/helpers.ts for the environment contract.

 Single-threaded on purpose: the tests share one Immich album and assert on
 its contents, and the admission-control test wants the whole upload budget
 to itself.
*/
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    // No retries: a flaky e2e is a signal, not noise to paper over.
    retry: 0
  }
})
