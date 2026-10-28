import { defineConfig } from '@playwright/test'

/*
  Browser layer for visitor uploads, separate from both `npm test` (unit,
  stubbed fetch) and `npm run test:e2e` (request level against a live
  Immich): this one drives the gallery and the upload page through the front
  proxy of test/immich-stack.yml. Opt-in on the same environment contract,
  see tests/e2e/helpers.ts.
*/
export default defineConfig({
  testDir: './tests/browser',
  timeout: 120000,
  expect: { timeout: 30000 },
  // Serial: the tests share one Immich album and assert on its contents
  workers: 1,
  fullyParallel: false,
  // No retries: a flaky browser test here means a real race in the client
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
