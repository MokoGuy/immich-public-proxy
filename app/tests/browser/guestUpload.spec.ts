/*
Guest upload driven through a real browser.

This layer exists because the request-level e2e suite cannot see the client at
all - it POSTs to the upload route directly. The first bug it caught was
exactly that kind: picking two files uploaded only one, because clearing
`input.value` empties the live FileList that `handleFiles` was still iterating.
Every request looked perfect; the page just silently dropped half the
selection.

Same environment contract as the e2e suite, plus Playwright:

  E2E_IPP_URL         deployed IPP with ipp.upload.enabled
  E2E_IMMICH_URL      the Immich behind it
  E2E_IMMICH_API_KEY  key allowed to create/delete albums, links and assets

  npm run test:browser
*/

import { test, expect } from '@playwright/test'
import { ImmichFixtures, makePng, readConfig } from '../e2e/helpers'

const cfg = readConfig()

test.describe('guest upload in the browser', () => {
  test.skip(!cfg, 'needs E2E_IPP_URL / E2E_IMMICH_URL / E2E_IMMICH_API_KEY')

  let fx: ImmichFixtures
  let albumId: string
  let uploadKey: string
  let readOnlyKey: string

  test.beforeAll(async () => {
    fx = new ImmichFixtures(cfg!)
    albumId = await fx.createAlbum('browser')
    uploadKey = (await fx.createShareLink(albumId, { allowUpload: true })).key
    readOnlyKey = (await fx.createShareLink(albumId, { allowUpload: false })).key
  })

  test.afterAll(async () => {
    const problems = await fx.teardown()
    if (problems.length) console.error('browser teardown problems:', problems)
  })

  test('shows the upload control only where uploads are allowed', async ({ page }) => {
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible()

    await page.goto(`${cfg!.ippUrl}/share/${readOnlyKey}`)
    await expect(page.getByRole('button', { name: 'Add photos' })).toHaveCount(0)
  })

  test('uploads EVERY file in a multi-file selection', async ({ page }) => {
    // The regression this file was written for. Two files must produce two
    // assets - one is the failure mode, not a partial success.
    const before = (await fx.albumAssetIds(albumId)).length

    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name: 'browser-a.png', mimeType: 'image/png', buffer: makePng(120, 90, false, 51) },
      { name: 'browser-b.png', mimeType: 'image/png', buffer: makePng(100, 80, false, 52) }
    ])

    // The client reloads on success; wait for the item count to settle.
    await expect.poll(async () => (await fx.albumAssetIds(albumId)).length, {
      timeout: 60000,
      intervals: [1000]
    }).toBe(before + 2)

    const names = await Promise.all(
      (await fx.albumAssetIds(albumId)).map(id => fx.assetDetail(id).then(d => d.originalFileName))
    )
    expect(names).toContain('browser-a.png')
    expect(names).toContain('browser-b.png')
  })

  test('reports progress and then shows the new photo', async ({ page }) => {
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const before = (await fx.albumAssetIds(albumId)).length

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name: 'browser-status.png', mimeType: 'image/png', buffer: makePng(140, 100, false, 61) }
    ])

    // The status region is aria-live, so it must carry real text for a screen
    // reader rather than only changing colour.
    await expect(page.locator('#upload-status')).toContainText(/Uploading|Added/, { timeout: 30000 })

    await expect.poll(async () => (await fx.albumAssetIds(albumId)).length, {
      timeout: 60000,
      intervals: [1000]
    }).toBe(before + 1)

    // The client reloads itself; the new asset must be on the page that comes
    // back. Counting DOM tiles would be wrong - the gallery is virtualised and
    // only renders what is near the viewport, so assert on the id instead.
    const ids = await fx.albumAssetIds(albumId)
    const details = await Promise.all(ids.map(async id => ({ id, ...(await fx.assetDetail(id)) })))
    const uploaded = details.find(d => d.originalFileName === 'browser-status.png')
    expect(uploaded, 'the uploaded asset should be in the album').toBeTruthy()

    await expect.poll(async () => (await page.content()).includes(uploaded!.id), {
      timeout: 60000,
      intervals: [1000]
    }).toBe(true)
  })

  test('surfaces a rejection instead of failing silently', async ({ page }) => {
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const before = (await fx.albumAssetIds(albumId)).length

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    // Announced as a PNG, is not one: the server's magic-byte check refuses it.
    await (await chooser).setFiles([
      { name: 'not-really.png', mimeType: 'image/png', buffer: Buffer.from('PK' + 'A'.repeat(64), 'latin1') }
    ])

    await expect(page.locator('#upload-status')).toContainText(/failed/i, { timeout: 30000 })
    expect((await fx.albumAssetIds(albumId)).length).toBe(before)
  })

  test('does not leave the visitor on a cached page after uploading', async ({ page }) => {
    const res = await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    expect(res?.headers()['cache-control']).toBe('no-store')
  })
})
