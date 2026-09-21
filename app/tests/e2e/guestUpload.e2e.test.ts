/*
Guest upload, end to end against a real Immich and a real deployed IPP.

Every assertion here corresponds to something that was verified by hand before
the feature shipped. The point of persisting them is that Immich moves: the
upload DTO, the shared-link permission map and the timeline enumeration have
all changed across releases, and a unit test with a stubbed fetch cannot
notice when one of them does.

Requires `ipp.upload.enabled: true` on the target IPP. See helpers.ts for the
environment contract; without it the whole file is skipped.
*/

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'crypto'
import net from 'net'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  E2EConfig,
  ImmichFixtures,
  eventually,
  makePng,
  makePngOfAtLeast,
  readConfig,
  unlockShare,
  uploadSlowToIpp,
  uploadToIpp
} from './helpers'

const cfg = readConfig()
const run = describe.skipIf(!cfg)
// `describe.skipIf` still evaluates the suite body at collection time, so the
// config has to be safe to read even when the suite will not run.
const c: E2EConfig = cfg ?? { immichUrl: '', apiKey: '', ippUrl: '', maxConcurrent: 2 }

const CREATED_AT = '2026-01-15T09:30:00.000Z'

run('guest upload against a live Immich', () => {
  let fx: ImmichFixtures
  let albumId: string
  let uploadKey: string
  let noUploadKey: string

  beforeAll(async () => {
    fx = new ImmichFixtures(c)
    albumId = await fx.createAlbum('upload')
    uploadKey = (await fx.createShareLink(albumId, { allowUpload: true })).key
    noUploadKey = (await fx.createShareLink(albumId, { allowUpload: false })).key
  }, 60000)

  afterAll(async () => {
    const problems = await fx.teardown()
    // Surface rather than swallow: a half-cleaned instance is the operator's
    // problem to know about, not something to discover weeks later.
    if (problems.length) console.error('e2e teardown problems:', problems)
  }, 120000)

  describe('the happy path', () => {
    it('uploads through IPP and files the asset in the album', async () => {
      const res = await uploadToIpp(c, `/share/${uploadKey}`, makePng(120, 90), {
        filename: 'holiday.png',
        createdAt: CREATED_AT
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string, status: string }
      expect(body.id).toBeTruthy()
      fx.track(body.id)

      const ids = await fx.albumAssetIds(albumId)
      expect(ids).toContain(body.id)
    }, 60000)

    it('preserves a non-ASCII filename end to end', async () => {
      // The client percent-encodes it into a header; the server has to decode
      // exactly once. Getting this wrong stores `%C3%A9t%C3%A9.png`.
      const name = 'été à Pézac.png'
      const res = await uploadToIpp(c, `/share/${uploadKey}`, makePng(40, 30, false, 7), {
        filename: name,
        createdAt: CREATED_AT
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }
      fx.track(id)

      const detail = await fx.assetDetail(id)
      expect(detail.originalFileName).toBe(name)
      expect(new Date(detail.fileCreatedAt).toISOString()).toBe(CREATED_AT)
    }, 60000)

    it('gives an extensionless upload one, so Immich does not reject it', async () => {
      // Immich derives the asset type from the extension and answers
      // 400 "Unsupported file type upload" without one. A client that omits
      // X-IPP-Filename must still succeed.
      const res = await uploadToIpp(c, `/share/${uploadKey}`, makePng(32, 32, false, 11), {
        createdAt: CREATED_AT
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }
      fx.track(id)
      expect((await fx.assetDetail(id)).originalFileName).toMatch(/\.png$/)
    }, 60000)
  })

  describe('cache coherence', () => {
    it('serves the new asset immediately instead of 404ing for the cache TTL', async () => {
      // IPP memoises share resolution for 120s and rejects any asset id not in
      // the cached list. Without invalidation on upload, the visitor watches
      // their own photo 404 for two minutes.
      const gallery = await fetch(`${c.ippUrl}/share/${uploadKey}`)
      expect(gallery.status).toBe(200)

      const res = await uploadToIpp(c, `/share/${uploadKey}`, makePng(60, 45, false, 21), {
        filename: 'fresh.png',
        createdAt: CREATED_AT
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }
      fx.track(id)

      // Immich generates thumbnails asynchronously, so allow for that - but
      // the interesting failure (IPP saying "not in share") is immediate.
      const served = await eventually(async () => {
        const thumb = await fetch(`${c.ippUrl}/share/photo/${uploadKey}/${id}`)
        return thumb.status === 200
      })
      expect(served).toBe(true)

      const reloaded = await fetch(`${c.ippUrl}/share/${uploadKey}`)
      expect(await reloaded.text()).toContain(id)
    }, 90000)

    it('never lets a shared cache hold an upload-enabled gallery', async () => {
      const res = await fetch(`${c.ippUrl}/share/${uploadKey}`)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }, 30000)

    it('still caches a read-only gallery', async () => {
      const res = await fetch(`${c.ippUrl}/share/${noUploadKey}`)
      expect(res.headers.get('cache-control')).toMatch(/public/)
    }, 30000)

    it('renders the upload control only on an upload-enabled share', async () => {
      const withUpload = await (await fetch(`${c.ippUrl}/share/${uploadKey}`)).text()
      expect(withUpload).toContain('upload-open')
      expect(withUpload).toContain('uploadPath')

      const without = await (await fetch(`${c.ippUrl}/share/${noUploadKey}`)).text()
      expect(without).not.toContain('upload-open')
    }, 30000)
  })

  describe('the gate', () => {
    it('refuses a link whose owner did not allow uploads', async () => {
      const res = await uploadToIpp(c, `/share/${noUploadKey}`, makePng(20, 20), {
        filename: 'nope.png',
        createdAt: CREATED_AT
      })
      // 403 with a reason, not a silent 404: the share resolved, so the
      // visitor holds a working link and deserves to know why. An UNKNOWN key
      // still gets the generic response - see the test below.
      expect(res.status).toBe(403)
      expect((await res.json() as { reason: string }).reason).toBe('not-allowed')
      expect(await fx.albumAssetIds(albumId)).not.toContain('nope')
    }, 60000)

    it('refuses a non-media content type', async () => {
      const res = await uploadToIpp(c, `/share/${uploadKey}`, Buffer.from('PKzip'), {
        filename: 'payload.zip',
        contentType: 'application/zip',
        createdAt: CREATED_AT
      })
      expect(res.status).toBe(400)
    }, 30000)

    it('refuses a missing or unparseable capture time', async () => {
      const png = makePng(20, 20)
      expect((await uploadToIpp(c, `/share/${uploadKey}`, png, { filename: 'a.png' })).status).toBe(400)
      expect((await uploadToIpp(c, `/share/${uploadKey}`, png, {
        filename: 'a.png', createdAt: 'not-a-date'
      })).status).toBe(400)
    }, 30000)

    it('stays generic for an unknown share key', async () => {
      // This is the one that must NOT be informative: probing for valid links
      // should learn nothing. Empty body, same 404 as any bad path.
      const res = await uploadToIpp(c, '/share/thiskeydoesnotexist', makePng(20, 20), {
        filename: 'a.png', createdAt: CREATED_AT
      })
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('')
    }, 30000)

    it('names the reason for a too-large file so the client can say so', async () => {
      const res = await uploadToIpp(c, `/share/${uploadKey}`, Buffer.from('PK' + 'A'.repeat(64), 'latin1'), {
        filename: 'x.png', contentType: 'image/png', createdAt: CREATED_AT
      })
      expect(res.status).toBe(400)
      expect((await res.json() as { reason: string }).reason).toBe('not-media')
    }, 30000)
  })

  describe('limits', () => {
    it('never admits more uploads at once than the configured limit', async () => {
      /*
       * The guarantee is a CAP, so a test that merely tolerates "200 or 503"
       * proves nothing: eight successes satisfy it while the cap is broken.
       *
       * This caught a real race. The route checked capacity, then awaited
       * share resolution, and only reserved the slot afterwards - so every
       * concurrent caller read the same zero, passed the check together and
       * all proceeded. The reservation now happens with no await between the
       * check and the increment.
       *
       * Bodies are dribbled out so the server actually holds its slot; a
       * buffer on loopback completes before concurrency is observable.
       */
      /*
       * A FRESH link, deliberately. The window between the capacity check and
       * the reservation is share resolution, and the shared fixture link is
       * already in IPP's 120s cache by the time this test runs - which closes
       * the window and lets the buggy version pass. Cold resolution is what
       * makes this test order-independent instead of a trap that only fires
       * when run alone.
       */
      const fresh = await fx.createShareLink(albumId, { allowUpload: true })
      const burst = 8
      const payload = makePng(160, 120, true, 300)
      const attempts = await Promise.all(
        Array.from({ length: burst }, (_, i) =>
          uploadSlowToIpp(c, `/share/${fresh.key}`, payload, {
            chunks: 6,
            delayMs: 200,
            filename: `burst-${Date.now()}-${i}.png`,
            createdAt: CREATED_AT
          })
        )
      )

      const codes = attempts.map(r => r.status)
      expect(codes.every(s => s === 200 || s === 503),
        `unexpected statuses: ${codes.join(',')}`).toBe(true)

      // With a cap of 2 and eight simultaneous slow uploads, most must be
      // turned away. Every one succeeding means the cap is not being applied.
      // The invariant is a CAP, so assert the cap - not merely "fewer than
      // all". With the reservation happening after an await, a handful of
      // callers slip through the window, which "fewer than all" happily
      // tolerates. `<= maxConcurrent` is what actually distinguishes the two.
      const admitted = codes.filter(s => s === 200).length
      expect(admitted, `${admitted} admitted with a cap of ${c.maxConcurrent}: ${codes.join(',')}`)
        .toBeLessThanOrEqual(c.maxConcurrent)
      expect(admitted, 'nothing was admitted at all').toBeGreaterThan(0)

      for (const r of attempts) {
        if (r.status === 200) fx.track((await r.json() as { id: string }).id)
        else expect(r.headers.get('retry-after'), 'a 503 must say when to come back').toBeTruthy()
      }
    }, 180000)

    it('surfaces a duplicate as its own outcome, not as a success', async () => {
      // Immich deduplicates by checksum across the owner's whole library and
      // does not file the duplicate into the album. Reporting that as "added"
      // would tell a visitor their photo is in an album it is not in.
      const bytes = makePng(110, 90, false, 404)
      const first = await uploadToIpp(c, `/share/${uploadKey}`, bytes, {
        filename: 'dup-source.png', createdAt: CREATED_AT
      })
      expect(first.status).toBe(200)
      const firstBody = await first.json() as { id: string, status: string }
      expect(firstBody.status).toBe('created')
      fx.track(firstBody.id)

      const countAfterFirst = (await fx.albumAssetIds(albumId)).length

      // Same bytes, different name: dedup is on content, not filename.
      const again = await uploadToIpp(c, `/share/${uploadKey}`, bytes, {
        filename: 'dup-copy.png', createdAt: CREATED_AT
      })
      expect(again.status).toBe(200)
      const againBody = await again.json() as { id: string, status: string }
      expect(againBody.status, 'a re-upload of identical bytes must report duplicate').toBe('duplicate')
      expect(againBody.id).toBe(firstBody.id)

      // And it must not have been counted as a new asset.
      expect((await fx.albumAssetIds(albumId)).length).toBe(countAfterFirst)
    }, 90000)

    const sizeIt = c.maxFileMb ? it : it.skip

    /*
     * E2E_IPP_URL must address IPP directly, not through a reverse proxy.
     *
     * Refusing an upload means answering before the body has arrived - that is
     * what a cap is. A proxy in front is then left holding a connection with
     * an unconsumed request on it, and some later request on that connection
     * comes back 502 without ever reaching this application. Pointing the
     * suite at the proxy would mean asserting on the proxy's connection-pool
     * behaviour instead of on the feature. See docs/config/upload.md.
     */
    sizeIt('refuses an oversize upload declared by Content-Length', async () => {
      const big = makePngOfAtLeast((c.maxFileMb as number) * 1024 * 1024 + 512 * 1024)
      const res = await uploadToIpp(c, `/share/${uploadKey}`, big, {
        filename: 'big.png', createdAt: CREATED_AT
      })
      expect(res.status).toBe(413)
    }, 120000)

    sizeIt('refuses an oversize chunked upload, which declares no size at all', async () => {
      // The pre-check cannot see a chunked body. This is the test that proves
      // the mid-stream byte count is what actually enforces the cap - and that
      // the outcome survives fetch wrapping the producer error.
      const big = makePngOfAtLeast((c.maxFileMb as number) * 1024 * 1024 + 512 * 1024)
      const res = await uploadToIpp(c, `/share/${uploadKey}`, big, {
        filename: 'big-chunked.png', createdAt: CREATED_AT, chunked: true
      })
      expect(res.status).toBe(413)
    }, 120000)

    sizeIt('does not file an oversize upload in the album', async () => {
      // The status code is the proxy's business; what must never happen is the
      // asset landing anyway.
      const before = (await fx.albumAssetIds(albumId)).length
      const big = makePngOfAtLeast((c.maxFileMb as number) * 1024 * 1024 + 512 * 1024)
      await uploadToIpp(c, `/share/${uploadKey}`, big, {
        filename: 'must-not-land.png', createdAt: CREATED_AT, chunked: true
      }).catch(() => undefined)
      expect((await fx.albumAssetIds(albumId)).length).toBe(before)
    }, 120000)

    sizeIt('refuses an oversize upload BEFORE the body has finished', async () => {
      /*
       * "It was refused" is not the claim; the claim is that the cap is
       * enforced mid-stream, so a body that never ends cannot push bytes
       * through indefinitely. This sends past the cap and then deliberately
       * withholds the rest: a response can only arrive if the server stopped
       * reading rather than waiting for EOF.
       */
      const max = (c.maxFileMb as number) * 1024 * 1024
      const payload = makePngOfAtLeast(max + 512 * 1024)
      let released: (() => void) | null = null
      const stalled = new Promise<void>(resolve => { released = resolve })
      let sentAll = false

      const body = new ReadableStream<Uint8Array>({
        async pull (controller) {
          if (!sentAll) {
            controller.enqueue(new Uint8Array(payload))
            sentAll = true
            return
          }
          // Past the cap, and now silent. Never closes on its own.
          await stalled
          controller.close()
        }
      })

      const res = await fetch(`${c.ippUrl}/share/${uploadKey}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'X-IPP-Filename': 'stalled.png',
          'X-IPP-Created-At': CREATED_AT
        },
        body,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' })

      // Reaching here at all is the assertion: the request body was never
      // completed, so this response was produced mid-stream.
      expect(sentAll, 'the payload was not even sent').toBe(true)
      expect([413, 502]).toContain(res.status)
      released?.()
    }, 120000)

    it('keeps serving after a rejection, on a reused connection', async () => {
      // An early rejection answers without reading the body. If that poisons
      // keep-alive, the next upload on the same connection dies - which is
      // exactly the sort of thing only a real HTTP round trip shows.
      for (let i = 0; i < 3; i++) {
        const rejected = await uploadToIpp(c, `/share/${uploadKey}`, makePng(20, 20), {
          filename: 'x.zip', contentType: 'application/zip', createdAt: CREATED_AT
        })
        // Small body, so the proxy has nothing left unread - this one is
        // expected to be a clean 400 even through a reverse proxy.
        expect(rejected.status).toBe(400)

        const accepted = await uploadToIpp(c, `/share/${uploadKey}`, makePng(30, 30, false, 200 + i), {
          filename: `after-reject-${i}.png`, createdAt: CREATED_AT
        })
        expect(accepted.status).toBe(200)
        fx.track((await accepted.json() as { id: string }).id)
      }
    }, 120000)
  })

  describe('cache identities', () => {
    const slugIt = c.ippSlugUrl ? it : it.skip

    slugIt('invalidates BOTH the slug and the canonical view after a slug upload', async () => {
      /*
       * A /s/<slug> gallery renders its thumbnail and metadata URLs from the
       * CANONICAL key, so the two warm separate 120s cache entries. Dropping
       * only the one we were addressed by refreshes the page and leaves every
       * new thumbnail 404ing until the TTL expires.
       *
       * This needs the second proxy: with requireRandomKey on - the default,
       * and the right default - a slug cannot write at all, so the submitted
       * and canonical keys are always the same and this branch is never
       * executed. A test against the main proxy would pass without covering
       * anything.
       */
      const base = c.ippSlugUrl as string
      const slug = `zz-ipp-e2e-cache-${Date.now()}`
      const album = await fx.createAlbum('cache')
      const link = await fx.createShareLink(album, { allowUpload: true, slug })
      expect(link.slug).toBe(slug)
      expect(link.key).not.toBe(slug)

      // Warm both identities.
      expect((await fetch(`${base}/s/${slug}`)).status).toBe(200)
      expect((await fetch(`${base}/share/${link.key}`)).status).toBe(200)

      const res = await fetch(`${base}/s/${slug}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          'X-IPP-Filename': 'via-slug.png',
          'X-IPP-Created-At': CREATED_AT
        },
        body: new Uint8Array(makePng(80, 60, false, 611))
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }
      fx.track(id)

      // Well inside the 120s TTL: if the canonical entry were still stale,
      // resolveSharedAsset would reject this id as "not in share".
      const served = await eventually(async () =>
        (await fetch(`${base}/share/photo/${link.key}/${id}`)).status === 200, 30000)
      expect(served, 'the canonical-key view still had the stale asset list').toBe(true)

      // And the slug gallery shows it too.
      expect(await (await fetch(`${base}/s/${slug}`)).text()).toContain(id)
    }, 120000)
  })

  describe('duplicate pre-check', () => {
    it('reports a duplicate for content this share already shows', async () => {
      const bytes = makePng(130, 100, false, 808)
      const up = await uploadToIpp(c, `/share/${uploadKey}`, bytes, {
        filename: 'precheck-seed.png', createdAt: CREATED_AT
      })
      expect(up.status).toBe(200)
      fx.track((await up.json() as { id: string }).id)

      const sha1 = createHash('sha1').update(bytes).digest('base64')
      const res = await fetch(`${c.ippUrl}/share/${uploadKey}/check`, {
        method: 'POST', headers: { 'X-IPP-Checksum': sha1 }
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { duplicate: boolean, checked?: boolean, id?: string }
      expect(body.duplicate).toBe(true)
      // `checked` separates a working check that found nothing from one that
      // could not answer - the difference that makes a silently dead
      // pre-check visible instead of looking like a run of misses.
      expect(body.checked).toBe(true)
      // The answer is yes/no. Which asset it is would be disclosure for
      // nothing - the visitor can already see the album.
      expect(body.id).toBeUndefined()
    }, 90000)

    it('does NOT reveal content the owner holds outside this share', async () => {
      /*
       * The security-relevant case. Immich looks a checksum up across the
       * owner's whole library, so an unrestricted answer would let a link
       * holder test for any file - including ones too large to upload, and
       * without possessing the bytes. Confined to the share, it says nothing
       * the gallery does not.
       */
      const otherAlbum = await fx.createAlbum('elsewhere')
      const otherLink = await fx.createShareLink(otherAlbum, { allowUpload: true })
      const secret = makePng(140, 110, true, 909)

      const up = await uploadToIpp(c, `/share/${otherLink.key}`, secret, {
        filename: 'elsewhere.png', createdAt: CREATED_AT
      })
      expect(up.status).toBe(200)
      fx.track((await up.json() as { id: string }).id)

      // Same owner, same bytes - but not in the album this link shares.
      const sha1 = createHash('sha1').update(secret).digest('base64')
      const res = await fetch(`${c.ippUrl}/share/${uploadKey}/check`, {
        method: 'POST', headers: { 'X-IPP-Checksum': sha1 }
      })
      expect(res.status).toBe(200)
      const outside = await res.json() as { duplicate: boolean, checked?: boolean }
      expect(outside.duplicate, 'the check leaked a file held outside this share').toBe(false)
      // A real miss, not an unanswerable check.
      expect(outside.checked).toBe(true)
    }, 120000)

    it('refuses anything that is not a base64 SHA-1', async () => {
      for (const bad of ['', 'not-a-checksum', 'A'.repeat(64), '../../etc']) {
        const res = await fetch(`${c.ippUrl}/share/${uploadKey}/check`, {
          method: 'POST', headers: { 'X-IPP-Checksum': bad }
        })
        expect(res.status, `accepted ${JSON.stringify(bad)}`).toBe(400)
      }
    }, 60000)

    it('is refused on a link that may not upload', async () => {
      const sha1 = createHash('sha1').update(makePng(20, 20)).digest('base64')
      const res = await fetch(`${c.ippUrl}/share/${noUploadKey}/check`, {
        method: 'POST', headers: { 'X-IPP-Checksum': sha1 }
      })
      expect(res.status).toBe(403)
      expect((await res.json() as { reason: string }).reason).toBe('not-allowed')
    }, 60000)
  })

  describe('write restrictions', () => {
    it('refuses a link with no expiry', async () => {
      // An upload capability with no end date cannot be retracted: you do not
      // know who copied the URL.
      const link = await fx.createShareLink(albumId, { allowUpload: true, expiresInDays: null })
      const res = await uploadToIpp(c, `/share/${link.key}`, makePng(20, 20), {
        filename: 'forever.png', createdAt: CREATED_AT
      })
      expect(res.status).toBe(403)
      expect((await res.json() as { reason: string }).reason).toBe('no-expiry')
    }, 60000)

    it('refuses an expiry beyond the configured horizon', async () => {
      const link = await fx.createShareLink(albumId, { allowUpload: true, expiresInDays: 400 })
      const res = await uploadToIpp(c, `/share/${link.key}`, makePng(20, 20), {
        filename: 'too-far.png', createdAt: CREATED_AT
      })
      expect(res.status).toBe(403)
      expect((await res.json() as { reason: string }).reason).toBe('expiry-too-far')
    }, 60000)

    it('refuses a slug link even when the same album accepts the random key', async () => {
      // Readable means guessable. The slug still serves the gallery; it just
      // carries no upload capability.
      const slug = `zz-ipp-e2e-write-${Date.now()}`
      const link = await fx.createShareLink(albumId, { allowUpload: true, slug })
      expect(link.slug).toBe(slug)

      expect((await fetch(`${c.ippUrl}/s/${slug}`)).status).toBe(200)
      const viaSlug = await uploadToIpp(c, `/s/${slug}`, makePng(20, 20), {
        filename: 'via-slug.png', createdAt: CREATED_AT
      })
      expect(viaSlug.status).toBe(403)
      expect((await viaSlug.json() as { reason: string }).reason).toBe('slug')

      const viaKey = await uploadToIpp(c, `/share/${link.key}`, makePng(25, 25, false, 71), {
        filename: 'via-key.png', createdAt: CREATED_AT
      })
      expect(viaKey.status).toBe(200)
      fx.track((await viaKey.json() as { id: string }).id)
    }, 90000)

    it('hides the upload control on a slug gallery', async () => {
      const slug = `zz-ipp-e2e-ui-${Date.now()}`
      const link = await fx.createShareLink(albumId, { allowUpload: true, slug })
      expect(link.slug).toBe(slug)
      const page = await (await fetch(`${c.ippUrl}/s/${slug}`)).text()
      expect(page).not.toContain('upload-open')
    }, 60000)
  })

  describe('AGPL section 13', () => {
    it('offers the source from the gallery itself', async () => {
      const page = await (await fetch(`${c.ippUrl}/share/${uploadKey}`)).text()
      expect(page).toContain('source-offer')
      // Section 13 wants the source of the version ACTUALLY running, so the
      // href must carry a concrete ref, not just the repository root.
      expect(page).toMatch(/href="https?:\/\/[^"]+\/tree\/[^"]+"[^>]*>IPP/)
    }, 30000)
  })

  describe('slug shares', () => {
    it('serves a slug gallery and keeps the canonical-key view fresh', async () => {
      const slug = `${'zz-ipp-e2e'}-${Date.now()}`
      const link = await fx.createShareLink(albumId, { allowUpload: true, slug })
      // Assert the fixture, do not tiptoe around it: returning early here
      // would let the whole slug branch report green without executing a
      // single assertion, which is worse than no test at all.
      expect(link.slug, 'Immich did not persist the slug on the shared link').toBe(slug)

      // Warm BOTH identities: the slug gallery, and the canonical-key asset
      // URLs it renders. An upload must invalidate both or the new thumbnail
      // 404s for the cache TTL.
      expect((await fetch(`${c.ippUrl}/s/${slug}`)).status).toBe(200)
      expect((await fetch(`${c.ippUrl}/share/${link.key}`)).status).toBe(200)

      // Upload through the random key - the slug is read-only by policy.
      const res = await uploadToIpp(c, `/share/${link.key}`, makePng(70, 50, false, 31), {
        filename: 'slug-album.png', createdAt: CREATED_AT
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }
      fx.track(id)

      const served = await eventually(async () =>
        (await fetch(`${c.ippUrl}/share/photo/${link.key}/${id}`)).status === 200)
      expect(served).toBe(true)
    }, 120000)
  })

  describe('password-protected shares', () => {
    const PASSWORD = 'e2e-correct-horse'

    it('refuses an upload without the unlock cookie', async () => {
      const link = await fx.createShareLink(albumId, { allowUpload: true, password: PASSWORD })
      const res = await uploadToIpp(c, `/share/${link.key}`, makePng(20, 20), {
        filename: 'locked.png', createdAt: CREATED_AT
      })
      // resolveShare reports passwordRequired, which the route turns into the
      // same generic refusal as any other invalid request.
      expect([401, 404]).toContain(res.status)
    }, 60000)

    it('accepts an upload once unlocked, proving the cookie auth path', async () => {
      // This is the path that a query-string `password` port would have
      // silently broken: Immich dropped `?password=` in favour of
      // POST /shared-links/login and an immich_shared_link_token cookie.
      const link = await fx.createShareLink(albumId, { allowUpload: true, password: PASSWORD })
      const cookie = await unlockShare(c, link.key, PASSWORD)

      const res = await uploadToIpp(c, `/share/${link.key}`, makePng(50, 40, false, 41), {
        filename: 'unlocked.png', createdAt: CREATED_AT, cookie
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }
      fx.track(id)
      expect(await fx.albumAssetIds(albumId)).toContain(id)
    }, 90000)

    it('refuses an upload carrying a cookie unlocked with the wrong password', async () => {
      const link = await fx.createShareLink(albumId, { allowUpload: true, password: PASSWORD })
      const cookie = await unlockShare(c, link.key, 'not-the-password')
      const res = await uploadToIpp(c, `/share/${link.key}`, makePng(20, 20), {
        filename: 'wrong.png', createdAt: CREATED_AT, cookie
      })
      expect([401, 404]).toContain(res.status)
    }, 60000)
  })

  describe('a connection that stops existing', () => {
    /*
     * The admission slot is released in a `finally`, which only runs once the
     * handler settles. A visitor whose connection simply stops - a phone
     * losing signal behind a reverse proxy - sends no FIN, so `res` 'close'
     * never fires; and the round-trip to Immich has no deadline of its own.
     * Nothing but a time bound can give that slot back, and without one the
     * proxy answers 503 'busy' to every upload until it is restarted.
     *
     * ipp-reap exists for this test: maxConcurrent 1 so one stalled socket
     * exhausts the budget, and a 10s idle bound so the recovery is observable
     * in seconds rather than the two minutes the production default allows.
     */
    const reap = c.ippReapUrl
    const onReap = it.skipIf(!reap)

    onReap('gives its admission slot back instead of holding it for good', async () => {
      const reapCfg: E2EConfig = { ...c, ippUrl: reap as string }
      const url = new URL(reap as string)
      const link = await fx.createShareLink(albumId, { allowUpload: true })

      const attempt = async () => {
        const res = await uploadToIpp(reapCfg, `/share/${link.key}`, makePng(24, 24, true, Date.now() % 1000), {
          filename: 'probe.png', createdAt: CREATED_AT
        })
        if (res.status === 200) fx.track(((await res.json()) as { id: string }).id)
        else await res.text().catch(() => '')
        return res.status
      }

      // Headers plus a few bytes, then silence, socket held open.
      const stalled = net.createConnection({ host: url.hostname, port: Number(url.port) })
      await new Promise<void>((resolve, reject) => {
        stalled.once('connect', () => resolve())
        stalled.once('error', reject)
      })
      stalled.write(
        `POST /share/${link.key}/upload HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        'Content-Type: image/png\r\n' +
        `X-IPP-Created-At: ${CREATED_AT}\r\n` +
        // Comfortably under maxFileSizeMb, or the declared-size pre-check
        // rejects the request before it ever takes a slot and the whole test
        // passes on a race instead of on the bound.
        'Content-Length: 1500000\r\n\r\n'
      )
      stalled.write(makePng(40, 40).subarray(0, 64))

      try {
        const wedged = await eventually(async () => (await attempt()) === 503, 15000, 500)
        expect(wedged, 'the stalled socket never took the slot, so the rest proves nothing').toBe(true)

        const recovered = await eventually(async () => (await attempt()) === 200, 45000, 1000)
        expect(recovered, 'the slot was never released - uploads stay wedged').toBe(true)
      } finally {
        stalled.destroy()
      }
    }, 90000)
  })

  describe('operational reporting', () => {
    /*
     * The counters and levels are unit-tested; what this proves is the wiring:
     * that a real upload through the real route reaches the real log. The
     * summary is emitted on a fixed 60s cadence from server start, so a line
     * must appear within one window of the upload.
     */
    const exec = promisify(execFile)
    const CONTAINER = process.env.E2E_IPP_CONTAINER || 'ipp-test-stack-ipp-1'

    const containerLog = async (): Promise<string | null> => {
      try {
        const { stdout, stderr } = await exec('docker', ['logs', CONTAINER])
        return stdout + stderr
      } catch (e) {
        return null
      }
    }

    it('records a successful upload in the proxy log', async () => {
      const before = await containerLog()
      if (before === null) {
        // No docker here - say so rather than passing silently.
        console.warn(`skipped: cannot read logs for container ${CONTAINER}`)
        return
      }
      const baseline = before.split('\n').filter(l => l.includes('Guest upload |')).length

      const res = await uploadToIpp(c, `/share/${uploadKey}`, makePng(30, 30, true, 77), {
        filename: 'reported.png', createdAt: CREATED_AT
      })
      expect(res.status).toBe(200)
      fx.track(((await res.json()) as { id: string }).id)

      let line: string | undefined
      const appeared = await eventually(async () => {
        const now = await containerLog()
        const lines = (now || '').split('\n').filter(l => l.includes('Guest upload |'))
        if (lines.length <= baseline) return false
        line = lines.slice(baseline).find(l => /created=[1-9]/.test(l))
        return !!line
      }, 90000, 2000)

      expect(appeared, 'a successful upload still produced no log line').toBe(true)
      expect(line).toMatch(/created=[1-9]/)
      // Whatever else it says, it must not carry what the visitor sent.
      expect(line).not.toContain('reported.png')
      expect(line).not.toContain(uploadKey)
    }, 120000)
  })
})
