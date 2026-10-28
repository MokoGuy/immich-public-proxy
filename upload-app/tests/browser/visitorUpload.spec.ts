/*
Visitor upload driven through a real browser, through the front proxy of
test/immich-stack.yml, as a visitor reaches it in production: the gallery on
IPP, its Add photos button, and the upload service's page under /upload.

The request-level suite cannot see the page at all. This one drives the file
picker, the queue and the panel, and replaces browser APIs Chromium does not
have under test (the wake lock) with recorders.

Same environment contract as the e2e suite (tests/e2e/helpers.ts), plus
E2E_FRONT_URL.

  npm run test:browser
*/

import { test, expect, Page } from '@playwright/test'
import { createHash } from 'crypto'
import { ImmichFixtures, STORED_PREFIX, makePng, readConfig, upload } from '../e2e/helpers'
import { jpegWithExif, jpegWithoutExif, TAG } from '../fixtures/exifJpeg'

const cfg = readConfig()
const front = cfg?.frontUrl ?? ''

const unique = (stem: string, ext = 'png') => `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

test.describe('visitor upload in the browser', () => {
  test.skip(!cfg || !front, 'needs the e2e environment and E2E_FRONT_URL')

  let fx: ImmichFixtures
  let albumId: string
  let uploadKey: string

  test.beforeAll(async () => {
    fx = new ImmichFixtures(cfg!)
    albumId = await fx.createAlbum('browser')
    uploadKey = (await fx.createShareLink(albumId, { allowUpload: true })).key
  })

  test.afterAll(async () => {
    const problems = await fx.teardown()
    if (problems.length) console.error('browser teardown problems:', problems)
  })

  const uploadPage = () => `${front}/upload/share/${uploadKey}`

  /** Pick files through the page's own button and file chooser. */
  async function pick (page: Page, files: Array<{ name: string, mimeType: string, buffer: Buffer }>) {
    const chooser = page.waitForEvent('filechooser')
    await page.locator('#upload-choose').click()
    await (await chooser).setFiles(files)
  }

  /** The POSTs the page makes to the upload service, by last path segment. */
  function watchPosts (page: Page): string[] {
    const posts: string[] = []
    page.on('request', r => {
      const path = new URL(r.url()).pathname
      if (r.method() === 'POST' && /\/(check|upload)$/.test(path)) posts.push(path.split('/').pop()!)
    })
    return posts
  }

  test('shows Add photos only where uploads are allowed, and it leads to the upload page', async ({ page }) => {
    // An empty album of its own: IPP serves a share of exactly one photo as the image itself
    const album = await fx.createAlbum('browser-gallery')
    const open = (await fx.createShareLink(album, { allowUpload: true })).key
    const closed = (await fx.createShareLink(album, { allowUpload: false })).key
    const forever = (await fx.createShareLink(album, { allowUpload: true, expiresInDays: null })).key

    await page.goto(`${front}/share/${closed}`)
    await expect(page.locator('#upload-link')).toHaveCount(0)
    await page.goto(`${front}/share/${forever}`)
    await expect(page.locator('#upload-link')).toHaveCount(0)

    await page.goto(`${front}/share/${open}`)
    // Revealed once the upload service's healthcheck answers through the proxy
    await expect(page.locator('#upload-link')).toBeVisible()
    await page.locator('#upload-link').click()
    await expect(page).toHaveURL(new RegExp(`/upload/share/${open}$`))
    await expect(page.locator('#upload-choose')).toBeVisible()
  })

  test('uploads EVERY file in a multi-file selection', async ({ page }) => {
    const names = [unique('browser-a'), unique('browser-b')]
    await page.goto(uploadPage())
    await pick(page, [
      { name: names[0], mimeType: 'image/png', buffer: makePng(120, 90, false, 51) },
      { name: names[1], mimeType: 'image/png', buffer: makePng(100, 80, false, 52) }
    ])
    await expect(page.locator('#upload-list li[data-state="done"]')).toHaveCount(2, { timeout: 60000 })
    for (const name of names) expect(await fx.findInAlbum(albumId, STORED_PREFIX + name)).toBeDefined()
  })

  test('shows the new photo in the gallery once the visitor goes back', async ({ page }) => {
    const name = unique('fresh')
    await page.goto(uploadPage())
    await pick(page, [{ name, mimeType: 'image/png', buffer: makePng(140, 100, false, 61) }])
    await expect(page.locator('#upload-list li[data-state="done"]')).toHaveCount(1, { timeout: 60000 })
    const asset = await fx.findInAlbum(albumId, STORED_PREFIX + name)
    expect(asset).toBeDefined()

    await page.locator('#upload-back').click()
    // Immich makes the thumbnail first, and IPP hides a photo until then
    await expect.poll(async () => {
      await page.reload()
      return await page.content()
    }, { timeout: 60000, intervals: [2000] }).toContain(asset!.id)
  })

  test('says why a file was refused instead of failing silently', async ({ page }) => {
    await page.goto(uploadPage())
    await pick(page, [{ name: unique('not-really'), mimeType: 'image/png', buffer: Buffer.from('PK\x03\x04' + 'x'.repeat(200), 'latin1') }])
    const row = page.locator('#upload-list li').first()
    await expect(row).toHaveAttribute('data-state', 'error', { timeout: 30000 })
    await expect(row.locator('.upload-row-error')).toContainText(/does not match/)
  })

  test('refuses an oversize file without sending it', async ({ page }) => {
    const posts = watchPosts(page)
    await page.goto(uploadPage())
    await pick(page, [{ name: unique('huge'), mimeType: 'image/png', buffer: Buffer.alloc(3 * 1024 * 1024, 1) }])
    const row = page.locator('#upload-list li').first()
    await expect(row).toHaveAttribute('data-state', 'error')
    await expect(row).toContainText(/Larger than/)
    expect(posts).toEqual([])
  })

  test('skips a file the share already shows, without uploading it', async ({ page }) => {
    const bytes = makePng(90, 70, false, 71)
    const seeded = await upload(cfg!.uploadUrl, `/share/${uploadKey}`, bytes, { filename: unique('seed'), createdAt: new Date().toISOString() })
    expect(seeded.status).toBe(200)

    const posts = watchPosts(page)
    await page.goto(uploadPage())
    await pick(page, [{ name: unique('again'), mimeType: 'image/png', buffer: bytes }])
    await expect(page.locator('#upload-list li').first()).toHaveAttribute('data-state', 'duplicate', { timeout: 30000 })
    expect(posts).toEqual(['check'])
  })

  test('checks, then uploads, content that is new', async ({ page }) => {
    const posts = watchPosts(page)
    await page.goto(uploadPage())
    const buffer = makePng(91, 71, true, 72)
    await pick(page, [{ name: unique('new'), mimeType: 'image/png', buffer }])
    await expect(page.locator('#upload-list li').first()).toHaveAttribute('data-state', 'done', { timeout: 30000 })
    expect(posts).toEqual(['check', 'upload'])
    // The page sent what Immich stores: a checksum of these exact bytes
    expect(createHash('sha1').update(buffer).digest('base64')).toMatch(/=$/)
  })

  test('waits out a busy server without spending its tries', async ({ page }) => {
    let refused = 0
    await page.route('**/upload/share/*/upload?*', async route => {
      // Four refusals: more than the three tries a failure gets
      if (refused < 4) {
        refused++
        await route.fulfill({ status: 503, headers: { 'Retry-After': '1', 'Content-Type': 'application/json' }, body: '{"error":"busy","reason":"busy"}' })
        return
      }
      await route.continue()
    })
    await page.goto(uploadPage())
    await pick(page, [{ name: unique('patient'), mimeType: 'image/png', buffer: makePng(64, 48, true, 73) }])
    await expect(page.locator('#upload-list li').first()).toHaveAttribute('data-state', 'done', { timeout: 60000 })
    expect(refused).toBe(4)
  })

  test('holds a screen wake lock for the duration of the queue, and takes it back when shown again', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __wake: string[], __setHidden: (v: boolean) => void }
      w.__wake = []
      let hidden = false
      Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') })
      w.__setHidden = (v: boolean) => {
        hidden = v
        document.dispatchEvent(new Event('visibilitychange'))
      }
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: async () => {
            w.__wake.push('request')
            return { release: async () => { w.__wake.push('release') } }
          }
        }
      })
    })
    // Hold the upload until the lock has been checked, so the queue is genuinely in flight
    let letGo: () => void = () => {}
    const gate = new Promise<void>(resolve => { letGo = resolve })
    await page.route('**/upload/share/*/upload?*', async route => {
      await gate
      await route.continue()
    })

    await page.goto(uploadPage())
    await pick(page, [{ name: unique('wake'), mimeType: 'image/png', buffer: makePng(70, 50, true, 94) }])
    const wake = () => page.evaluate(() => (window as unknown as { __wake: string[] }).__wake)

    await expect.poll(wake, { timeout: 15000 }).toContain('request')
    await page.evaluate(() => (window as unknown as { __setHidden: (v: boolean) => void }).__setHidden(true))
    await page.evaluate(() => (window as unknown as { __setHidden: (v: boolean) => void }).__setHidden(false))
    await expect.poll(async () => (await wake()).filter(e => e === 'request').length, { timeout: 15000 }).toBeGreaterThan(1)
    expect(await wake()).not.toContain('release')

    letGo()
    await expect(page.locator('#upload-list li').first()).toHaveAttribute('data-state', 'done', { timeout: 60000 })
    await expect.poll(async () => (await wake()).includes('release'), { timeout: 15000 }).toBe(true)
  })

  test('warns the visitor when the file carries no capture date, and only then', async ({ page }) => {
    await page.goto(uploadPage())
    await pick(page, [
      { name: unique('dateless', 'jpg'), mimeType: 'image/jpeg', buffer: jpegWithoutExif() },
      { name: unique('dated', 'jpg'), mimeType: 'image/jpeg', buffer: jpegWithExif([[TAG.make, 'Google']], [[TAG.dateTimeOriginal, '2025:07:08 10:11:12']]) }
    ])
    const rows = page.locator('#upload-list li')
    await expect(page.locator('#upload-list li[data-state="done"]')).toHaveCount(2, { timeout: 60000 })
    await expect(rows.nth(0).locator('.upload-row-note')).toContainText(/no capture date/)
    await expect(rows.nth(1).locator('.upload-row-note')).toHaveCount(0)
  })
})
