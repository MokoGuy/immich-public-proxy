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

  test('shows the new photo once the visitor refreshes', async ({ page }) => {
    // The panel no longer reloads the page on a timer: a summary that
    // vanishes before it can be read is worse than none. The visitor decides
    // when to refresh, so the test has to press the button too.
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const before = (await fx.albumAssetIds(albumId)).length

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name: 'browser-status.png', mimeType: 'image/png', buffer: makePng(140, 100, false, 61) }
    ])

    await expect(page.locator('#upload-panel')).toBeVisible({ timeout: 30000 })
    const row = page.locator('#upload-files li', { hasText: 'browser-status.png' })
    await expect(row).toContainText('Added', { timeout: 60000 })

    await expect.poll(async () => (await fx.albumAssetIds(albumId)).length, {
      timeout: 60000, intervals: [1000]
    }).toBe(before + 1)

    // Refresh is offered only once there is something to see.
    const refresh = page.getByRole('button', { name: 'Refresh gallery' })
    await expect(refresh).toBeVisible()
    await refresh.click()
    await page.waitForLoadState('load')

    const ids = await fx.albumAssetIds(albumId)
    const details = await Promise.all(ids.map(async id => ({ id, ...(await fx.assetDetail(id)) })))
    const uploaded = details.find(d => d.originalFileName === 'browser-status.png')
    expect(uploaded, 'the uploaded asset should be in the album').toBeTruthy()

    // Counting DOM tiles would be wrong - the gallery is virtualised and only
    // renders what is near the viewport - so assert on the id in the page.
    await expect.poll(async () => (await page.content()).includes(uploaded!.id), {
      timeout: 60000, intervals: [1000]
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

    // The row must name the file AND the reason: retrying, picking another
    // file and asking the owner are different next steps.
    const row = page.locator('#upload-files li', { hasText: 'not-really.png' })
    await expect(row).toContainText(/not a photo or video/i, { timeout: 30000 })
    await expect(row).toHaveClass(/upload-item-failed/)
    // A failed row offers a retry rather than making them start over.
    await expect(row.getByRole('button', { name: /retry/i })).toBeVisible()
    expect((await fx.albumAssetIds(albumId)).length).toBe(before)
  })

  test('rejects an oversize file without uploading it', async ({ page }) => {
    // Caught in the browser from the size the file input reports, so nothing
    // is sent. On a phone connection, uploading and THEN being told is the
    // difference between an inconvenience and giving up.
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const before = (await fx.albumAssetIds(albumId)).length

    const requests: string[] = []
    page.on('request', r => { if (r.url().includes('/upload')) requests.push(r.url()) })

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(3 * 1024 * 1024, 7) }
    ])

    await expect(page.locator('#upload-files li', { hasText: 'huge.png' }))
      .toContainText(/larger than/i, { timeout: 30000 })
    expect(requests).toHaveLength(0)
    expect((await fx.albumAssetIds(albumId)).length).toBe(before)
  })

  test('reports real transfer progress, not just a file count', async ({ page }) => {
    // The whole reason for XHR over fetch: on a slow link one large file
    // dominates a run, and "1 of 2" cannot say whether it is moving.
    //
    // Asserting that SOME percentage appears would pass on an upload that had
    // already finished - "100% of 1 MB" matches too. So this samples the row
    // while the transfer runs and requires a reading strictly between 0 and
    // 100, which only exists if progress events are actually arriving.
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const client = await page.context().newCDPSession(page)
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 100, downloadThroughput: 4_000_000, uploadThroughput: 100_000
    })

    const seen: string[] = []
    const sampler = setInterval(() => {
      page.locator('#upload-files li').first().innerText()
        .then(t => seen.push(t))
        .catch(() => undefined)
    }, 200)

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    // Incompressible, so the throttle actually bites: ~1.1 MB at 100 kB/s.
    await (await chooser).setFiles([
      { name: `slow-${Date.now()}.png`, mimeType: 'image/png', buffer: makePng(700, 560, true, 91) }
    ])

    const row = page.locator('#upload-files li').first()
    await expect(row).toContainText(/Added|Already uploaded/, { timeout: 120000 })
    clearInterval(sampler)

    const percentages = [...seen.join('\n').matchAll(/(\d+)% of/g)].map(m => Number(m[1]))
    expect(percentages.length, 'no progress reading was ever rendered').toBeGreaterThan(0)
    expect(
      percentages.some(p => p > 0 && p < 100),
      `only saw ${percentages.join(',')} - no mid-transfer reading, so progress may be faked`
    ).toBe(true)
    // The rate is what answers "will this finish?"; it only appears once the
    // rolling estimate has two samples, i.e. once bytes are genuinely moving.
    expect(seen.join('\n')).toMatch(/\d+\s*(KB|MB)\/s/)
  })

  test('keeps the spinner alive across progress updates', async ({ page }) => {
    /*
     * Reported from a phone: the spinner restarted several times a second.
     * Cause was rebuilding the row's innerHTML on every progress event, which
     * destroys and recreates the SVG so its CSS animation begins again.
     *
     * Asserting "a spinner is visible" would not have caught it - a brand new
     * spinner is visible too. This holds a handle to the original element and
     * requires that very node to still be in the document after many updates.
     */
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const client = await page.context().newCDPSession(page)
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 100, downloadThroughput: 4_000_000, uploadThroughput: 100_000
    })

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name: `spin-${Date.now()}.png`, mimeType: 'image/png', buffer: makePng(700, 560, true, 92) }
    ])

    // Wait until the row is SENDING before taking the handle. The row passes
    // through a 'checking' state first, and rebuilding on a state change is
    // correct - the claim is that the spinner survives progress updates
    // WITHIN a state, not across every transition.
    const row = page.locator('#upload-files li').first()
    await expect(row).toContainText(/%\s+of/, { timeout: 60000 })

    const spinner = row.locator('.upload-ico-busy')
    await expect(spinner).toBeVisible()
    const handle = await spinner.elementHandle()
    expect(handle, 'no spinner element to hold on to').toBeTruthy()

    // Let a good number of progress events go by.
    await page.waitForTimeout(3000)

    expect(
      await handle!.evaluate(el => el.isConnected),
      'the spinner was replaced mid-transfer, so its animation restarts'
    ).toBe(true)

    // And the bar really did move while that same node stayed put.
    const width = await page.locator('#upload-files li .upload-bar-fill').first()
      .evaluate(el => parseFloat((el as HTMLElement).style.width))
    expect(width).toBeGreaterThan(0)
  })

  test('skips a file the owner already has, without uploading it', async ({ page }) => {
    /*
     * The point of the pre-check is bytes NOT sent, so this asserts on the
     * network: after the first upload, re-selecting the same content must
     * produce a /check request and no /upload request at all.
     *
     * Throttled, because on loopback an upload is fast enough that "it was
     * skipped" and "it uploaded quickly" look the same.
     */
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const bytes = makePng(600, 480, true, 77)
    const name = `dup-${Date.now()}.png`

    // First time: it really does upload.
    const firstChooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await firstChooser).setFiles([{ name, mimeType: 'image/png', buffer: bytes }])
    await expect(page.locator('#upload-files li', { hasText: name }))
      .toContainText('Added', { timeout: 60000 })

    // Second time: same bytes, different name - dedup is on content.
    await page.reload()
    const client = await page.context().newCDPSession(page)
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 100, downloadThroughput: 4_000_000, uploadThroughput: 100_000
    })
    const posts: string[] = []
    page.on('request', r => {
      if (r.method() === 'POST' && /\/(check|upload)$/.test(new URL(r.url()).pathname)) {
        posts.push(new URL(r.url()).pathname.split('/').pop()!)
      }
    })

    const secondName = `copy-${Date.now()}.png`
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([{ name: secondName, mimeType: 'image/png', buffer: bytes }])

    const row = page.locator('#upload-files li', { hasText: secondName })
    await expect(row).toContainText(/already uploaded/i, { timeout: 60000 })
    await expect(row).toHaveClass(/upload-item-duplicate/)

    expect(posts, `requests seen: ${posts.join(',')}`).toContain('check')
    expect(posts, 'the file was uploaded even though it was already known')
      .not.toContain('upload')
  })

  test('uploads normally when the content is new', async ({ page }) => {
    // The mirror of the test above: a pre-check that answered "duplicate" for
    // everything would pass that one and break the feature entirely.
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const posts: string[] = []
    page.on('request', r => {
      if (r.method() === 'POST' && /\/(check|upload)$/.test(new URL(r.url()).pathname)) {
        posts.push(new URL(r.url()).pathname.split('/').pop()!)
      }
    })

    const name = `fresh-${Date.now()}.png`
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name, mimeType: 'image/png', buffer: makePng(300, 240, true, Date.now() % 1000) }
    ])

    await expect(page.locator('#upload-files li', { hasText: name }))
      .toContainText('Added', { timeout: 60000 })
    expect(posts).toContain('check')
    expect(posts, 'new content must still be uploaded').toContain('upload')
  })

  test('announces milestones to a screen reader, not every byte', async ({ page }) => {
    /*
     * The visual bar updates many times a second. A live region echoing it
     * would be unusable, so the contract is: the file starting, roughly
     * every 15 seconds during a long transfer, and the final summary.
     *
     * "A live region exists" would pass with every announcement deleted, so
     * this records the actual mutations and asserts both that the milestones
     * are there AND that the count stays far below the number of progress
     * events driving the bar.
     */
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    await page.evaluate(() => {
      const w = window as unknown as { __live: string[] }
      w.__live = []
      const el = document.getElementById('upload-live')!
      new MutationObserver(() => {
        const t = (el.textContent || '').trim()
        if (t && t !== w.__live[w.__live.length - 1]) w.__live.push(t)
      }).observe(el, { childList: true, characterData: true, subtree: true })
    })

    const client = await page.context().newCDPSession(page)
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 100, downloadThroughput: 4_000_000, uploadThroughput: 100_000
    })

    const name = `announce-${Date.now()}.png`
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name, mimeType: 'image/png', buffer: makePng(700, 560, true, 93) }
    ])

    const row = page.locator('#upload-files li').first()
    await expect(row).toContainText(/Added|Already uploaded/, { timeout: 120000 })
    await page.waitForTimeout(500)

    const said = await page.evaluate(() => (window as unknown as { __live: string[] }).__live)
    expect(said.length, 'nothing was announced at all').toBeGreaterThan(0)
    expect(said.join(' | '), 'the file starting was never announced').toContain(name)
    expect(said.join(' | '), 'the outcome was never announced').toMatch(/Finished\./)
    // ~12s of transfer drives dozens of progress events; a handful of
    // announcements is the point. Ten is generous and still fails an
    // implementation that announces on every tick.
    expect(said.length, `too chatty: ${said.join(' | ')}`).toBeLessThan(10)
  })

  test('holds a screen wake lock for the duration of the queue', async ({ page }) => {
    /*
     * Both mobile platforms suspend a backgrounded page and kill the upload,
     * and the system releases the lock whenever the document is hidden - so
     * the lock has to be re-acquired when the page comes back, or the
     * feature does nothing in exactly the case it exists for.
     *
     * Chromium under test has no real wake lock, and asserting a DOM node
     * would prove nothing, so the API is replaced with a recorder before any
     * page script runs.
     */
    await page.addInitScript(() => {
      const w = window as unknown as { __wake: string[] }
      w.__wake = []
      let hidden = false
      Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') })
      ;(window as unknown as { __setHidden: (v: boolean) => void }).__setHidden = (v: boolean) => {
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

    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const client = await page.context().newCDPSession(page)
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 100, downloadThroughput: 4_000_000, uploadThroughput: 100_000
    })

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name: `wake-${Date.now()}.png`, mimeType: 'image/png', buffer: makePng(700, 560, true, 94) }
    ])

    const row = page.locator('#upload-files li').first()
    await expect(row).toContainText(/%\s+of/, { timeout: 60000 })
    expect(
      await page.evaluate(() => (window as unknown as { __wake: string[] }).__wake),
      'no wake lock was requested when the upload started'
    ).toContain('request')

    // Hide and show: the system drops the lock, so it must be taken again.
    await page.evaluate(() => (window as unknown as { __setHidden: (v: boolean) => void }).__setHidden(true))
    await page.evaluate(() => (window as unknown as { __setHidden: (v: boolean) => void }).__setHidden(false))
    await expect.poll(async () =>
      (await page.evaluate(() => (window as unknown as { __wake: string[] }).__wake))
        .filter(e => e === 'request').length,
    { timeout: 15000 }).toBeGreaterThan(1)

    await expect(row).toContainText(/Added|Already uploaded/, { timeout: 120000 })
    await expect.poll(async () =>
      (await page.evaluate(() => (window as unknown as { __wake: string[] }).__wake)).includes('release'),
    { timeout: 15000 }).toBe(true)
  })

  test('minimises to a badge and comes back', async ({ page }) => {
    await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add photos' }).click()
    await (await chooser).setFiles([
      { name: 'badge.png', mimeType: 'image/png', buffer: makePng(90, 70, false, 55) }
    ])
    await expect(page.locator('#upload-panel')).toBeVisible({ timeout: 30000 })
    await page.locator('#upload-minimise').click()
    await expect(page.locator('#upload-panel')).toBeHidden()
    await expect(page.locator('#upload-badge')).toBeVisible()
    await page.locator('#upload-badge').click()
    await expect(page.locator('#upload-panel')).toBeVisible()
  })

  test('does not leave the visitor on a cached page after uploading', async ({ page }) => {
    const res = await page.goto(`${cfg!.ippUrl}/share/${uploadKey}`)
    expect(res?.headers()['cache-control']).toBe('no-store')
  })
})
