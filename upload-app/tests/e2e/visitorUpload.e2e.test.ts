/*
Visitor upload, end to end against a real Immich, the real IPP container and
the real upload service container.

A unit test with a stubbed fetch cannot notice when Immich moves: the upload
DTO, the shared-link permission map and the checksum interceptor have all
changed across releases. These run against the pinned Immich of
test/immich-stack.yml. See helpers.ts for the environment contract; without
it the whole file is skipped.

The upload service is addressed directly, not through the front proxy:
refusing an upload means answering before the body has arrived, and a proxy
in front then holds a connection with an unread request on it. Through the
proxy, these tests would assert on its connection pool instead of on the
feature. The browser suite goes through the proxy.
*/

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'crypto'
import net from 'net'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  E2EConfig,
  ImmichFixtures,
  STORED_PREFIX,
  eventually,
  makePng,
  makePngOfAtLeast,
  readConfig,
  unlockShare,
  upload,
  uploadSlowly
} from './helpers'
import { jpegWithExif, jpegWithoutExif, TAG } from '../fixtures/exifJpeg'

const cfg = readConfig()
const run = describe.skipIf(!cfg)
// `describe.skipIf` still evaluates the suite body at collection time, so the
// config has to be safe to read even when the suite will not run
const c: E2EConfig = cfg ?? { immichUrl: '', apiKey: '', ippUrl: '', uploadUrl: '', maxConcurrent: 2 }
const U = c.uploadUrl

const CREATED_AT = '2026-01-15T09:30:00.000Z'

/** A unique filename, so a test finds its own asset among the album's. */
const unique = (stem: string, ext = 'png') => `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

run('visitor upload against a live Immich', () => {
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
    // Surface rather than swallow: a half-cleaned instance is worth knowing about
    if (problems.length) console.error('e2e teardown problems:', problems)
  }, 120000)

  /** Upload one PNG and return the stored asset, asserting it was created. */
  async function uploadOne (name = unique('photo'), seed = Date.now() % 100000) {
    const res = await upload(U, `/share/${uploadKey}`, makePng(48, 36, false, seed), { filename: name, createdAt: CREATED_AT })
    expect(res.status).toBe(200)
    const asset = await fx.findInAlbum(albumId, STORED_PREFIX + name)
    expect(asset, 'the upload reported success but is not in the album').toBeDefined()
    return asset!
  }

  describe('the happy path', () => {
    it('uploads through the share key and files the asset in the album', async () => {
      const name = unique('holiday')
      const res = await upload(U, `/share/${uploadKey}`, makePng(120, 90), { filename: name, createdAt: CREATED_AT })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'created' })
      const asset = await fx.findInAlbum(albumId, STORED_PREFIX + name)
      expect(asset).toBeDefined()
      expect(await fx.albumAssetIds(albumId)).toContain(asset!.id)
    }, 60000)

    it('preserves a non-ASCII filename end to end', async () => {
      const name = `été à Pézac ${Date.now()}.png`
      const res = await upload(U, `/share/${uploadKey}`, makePng(40, 30, false, 7), { filename: name, createdAt: CREATED_AT })
      expect(res.status).toBe(200)
      const asset = await fx.findInAlbum(albumId, STORED_PREFIX + name)
      expect(asset?.originalFileName).toBe(STORED_PREFIX + name)
      expect(new Date(asset!.fileCreatedAt).toISOString()).toBe(CREATED_AT)
    }, 60000)
  })

  describe('galleries and caches', () => {
    /*
      An album of its own, kept empty: IPP serves a share holding exactly one
      photo as the image itself rather than a gallery page, and the shared
      album passes through that state while Immich makes thumbnails.
    */
    let galleryAlbum: string
    let open: string
    let closed: string
    beforeAll(async () => {
      galleryAlbum = await fx.createAlbum('gallery')
      open = (await fx.createShareLink(galleryAlbum, { allowUpload: true })).key
      closed = (await fx.createShareLink(galleryAlbum, { allowUpload: false })).key
    }, 60000)

    it('never lets a browser or shared cache hold a gallery that takes uploads', async () => {
      const res = await fetch(`${c.ippUrl}/share/${open}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toMatch(/^no-store/)
    }, 30000)

    it('still caches a read-only gallery', async () => {
      const res = await fetch(`${c.ippUrl}/share/${closed}`)
      expect(res.headers.get('cache-control')).toMatch(/^public/)
    }, 30000)

    it('renders the Add photos button only where the upload service would accept', async () => {
      expect(await (await fetch(`${c.ippUrl}/share/${open}`)).text()).toContain('id="upload-link"')
      expect(await (await fetch(`${c.ippUrl}/share/${closed}`)).text()).not.toContain('id="upload-link"')
      const forever = await fx.createShareLink(galleryAlbum, { allowUpload: true, expiresInDays: null })
      const page = await fetch(`${c.ippUrl}/share/${forever.key}`)
      expect(await page.text()).not.toContain('id="upload-link"')
      expect(page.headers.get('cache-control')).toMatch(/^public/)
    }, 30000)
  })

  describe('the gate', () => {
    it('keeps a link whose owner did not allow uploads behind the 404 policy', async () => {
      const res = await upload(U, `/share/${noUploadKey}`, makePng(20, 20), { filename: 'nope.png', createdAt: CREATED_AT })
      expect(res.status).toBe(404)
      expect((await fetch(`${U}/share/${noUploadKey}`)).status).toBe(404)
    }, 60000)

    it('stays generic for an unknown share key', async () => {
      const res = await upload(U, '/share/thiskeydoesnotexist', makePng(20, 20), { filename: 'a.png', createdAt: CREATED_AT })
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('')
    }, 30000)

    it('refuses a non-media content type', async () => {
      const res = await upload(U, `/share/${uploadKey}`, Buffer.from('PKzip'), {
        filename: 'payload.zip', contentType: 'application/zip', createdAt: CREATED_AT
      })
      expect(res.status).toBe(415)
    }, 30000)

    it('refuses bytes that contradict the declared type, and stores nothing', async () => {
      const name = unique('not-really')
      const res = await upload(U, `/share/${uploadKey}`, Buffer.from('PK\x03\x04' + 'A'.repeat(64), 'latin1'), {
        filename: name, contentType: 'image/png', createdAt: CREATED_AT
      })
      expect(res.status).toBe(415)
      expect((await res.json() as { error: string }).error).toMatch(/does not match/)
      expect(await fx.findInAlbum(albumId, STORED_PREFIX + name)).toBeUndefined()
    }, 30000)

    it('refuses a capture date more than a day in the future', async () => {
      const future = new Date(Date.now() + 10 * 86400_000).toISOString()
      const res = await upload(U, `/share/${uploadKey}`, makePng(20, 20), { filename: 'future.png', createdAt: future })
      expect(res.status).toBe(400)
    }, 30000)

    it('refuses a body with no declared length', async () => {
      const res = await fetch(`${U}/share/${uploadKey}/upload?filename=chunked.png`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: new ReadableStream({ start (ctl) { ctl.enqueue(new Uint8Array(makePng(10, 10))); ctl.close() } }),
        duplex: 'half'
      } as RequestInit & { duplex: 'half' })
      expect(res.status).toBe(411)
    }, 30000)
  })

  describe('the per-link policy', () => {
    it('refuses a link with no expiry', async () => {
      const link = await fx.createShareLink(albumId, { allowUpload: true, expiresInDays: null })
      const res = await upload(U, `/share/${link.key}`, makePng(20, 20), { filename: 'forever.png', createdAt: CREATED_AT })
      expect(res.status).toBe(403)
      expect((await res.json() as { reason: string }).reason).toBe('no-expiry')
    }, 60000)

    it('refuses an expiry beyond the configured horizon', async () => {
      const link = await fx.createShareLink(albumId, { allowUpload: true, expiresInDays: 400 })
      const res = await upload(U, `/share/${link.key}`, makePng(20, 20), { filename: 'too-far.png', createdAt: CREATED_AT })
      expect(res.status).toBe(403)
      expect((await res.json() as { reason: string }).reason).toBe('expiry-too-far')
    }, 60000)

    it('refuses a slug link even when the same album accepts the random key', async () => {
      const slug = `zz-ipp-e2e-write-${Date.now()}`
      const link = await fx.createShareLink(albumId, { allowUpload: true, slug })
      expect(link.slug).toBe(slug)

      expect((await fetch(`${c.ippUrl}/s/${slug}`)).status).toBe(200)
      const viaSlug = await upload(U, `/s/${slug}`, makePng(20, 20), { filename: 'via-slug.png', createdAt: CREATED_AT })
      expect(viaSlug.status).toBe(403)
      expect((await viaSlug.json() as { reason: string }).reason).toBe('slug')

      const viaKey = await upload(U, `/share/${link.key}`, makePng(25, 25, false, 71), { filename: unique('via-key'), createdAt: CREATED_AT })
      expect(viaKey.status).toBe(200)
    }, 90000)

    it('hides the Add photos button on a slug gallery', async () => {
      const slug = `zz-ipp-e2e-ui-${Date.now()}`
      // An empty album, so IPP renders a gallery page rather than a lone image
      const link = await fx.createShareLink(await fx.createAlbum('slug-ui'), { allowUpload: true, slug })
      expect(link.slug).toBe(slug)
      const page = await (await fetch(`${c.ippUrl}/s/${slug}`)).text()
      expect(page).not.toContain('id="upload-link"')
    }, 60000)

    it('refuses a share of selected photos', async () => {
      const asset = await uploadOne()
      const res = await fetch(`${c.immichUrl}/api/shared-links`, {
        method: 'POST',
        headers: { 'x-api-key': c.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'INDIVIDUAL', assetIds: [asset.id], allowUpload: true, expiresAt: new Date(Date.now() + 86400_000).toISOString() })
      })
      // The scoped fixture key may not create individual shares; say so rather than pass silently
      if (!res.ok) {
        console.warn('skipped: cannot create an individual share with the fixture key (' + res.status + ')')
        return
      }
      const link = await res.json() as { key: string, id: string }
      try {
        const refused = await upload(U, `/share/${link.key}`, makePng(20, 20), { filename: 'individual.png', createdAt: CREATED_AT })
        expect(refused.status).toBe(403)
        expect((await refused.json() as { reason: string }).reason).toBe('not-album')
      } finally {
        await fetch(`${c.immichUrl}/api/shared-links/${link.id}`, { method: 'DELETE', headers: { 'x-api-key': c.apiKey } })
      }
    }, 60000)
  })

  describe('limits', () => {
    it('never admits more uploads at once than the configured limit', async () => {
      /*
        The guarantee is a CAP, so a test that merely tolerates "200 or 503"
        proves nothing. A FRESH link, so share resolution is cold: that await
        is the window in which a reservation made too late lets every caller
        through.
      */
      const fresh = await fx.createShareLink(albumId, { allowUpload: true })
      const burst = 8
      const payload = makePng(160, 120, true, 300)
      const attempts = await Promise.all(
        Array.from({ length: burst }, (_, i) =>
          uploadSlowly(U, `/share/${fresh.key}`, payload, {
            chunks: 6,
            delayMs: 200,
            filename: unique(`burst-${i}`),
            createdAt: CREATED_AT
          }).catch(() => null)
        )
      )
      const codes = attempts.map(r => r?.status ?? 0)
      // A refused request whose body was still in flight may surface as a reset (0)
      expect(codes.every(s => s === 200 || s === 503 || s === 0), `unexpected statuses: ${codes.join(',')}`).toBe(true)
      const admitted = codes.filter(s => s === 200).length
      expect(admitted, `${admitted} admitted with a cap of ${c.maxConcurrent}: ${codes.join(',')}`).toBeLessThanOrEqual(c.maxConcurrent)
      expect(admitted, 'nothing was admitted at all').toBeGreaterThan(0)
      for (const r of attempts) {
        if (r && r.status === 503) {
          expect(r.headers.get('retry-after'), 'a 503 must say when to come back').toBeTruthy()
          expect((await r.json() as { reason: string }).reason).toBe('busy')
        }
      }
    }, 180000)

    it('reports a re-upload of identical bytes as a duplicate, without a second asset', async () => {
      const bytes = makePng(110, 90, false, 404)
      const first = await upload(U, `/share/${uploadKey}`, bytes, { filename: unique('dup-source'), createdAt: CREATED_AT })
      expect(first.status).toBe(200)
      expect((await first.json() as { status: string }).status).toBe('created')
      const countAfterFirst = (await fx.albumAssetIds(albumId)).length

      const again = await upload(U, `/share/${uploadKey}`, bytes, { filename: unique('dup-copy'), createdAt: CREATED_AT })
      expect(again.status).toBe(200)
      expect((await again.json() as { status: string }).status).toBe('duplicate')
      expect((await fx.albumAssetIds(albumId)).length).toBe(countAfterFirst)
    }, 90000)

    const sizeIt = c.maxFileMb ? it : it.skip

    sizeIt('refuses an oversize upload declared by Content-Length', async () => {
      const big = makePngOfAtLeast((c.maxFileMb as number) * 1024 * 1024 + 512 * 1024)
      const res = await upload(U, `/share/${uploadKey}`, big, { filename: 'big.png', createdAt: CREATED_AT }).catch(() => null)
      // The refusal comes before the body is read, so the client may see a reset instead
      if (res) expect(res.status).toBe(413)
    }, 120000)

    sizeIt('answers an oversize declaration before a byte of the body is sent', async () => {
      const url = new URL(U)
      const socket = net.createConnection({ host: url.hostname, port: Number(url.port) })
      await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject) })
      const reply = new Promise<string>(resolve => {
        let text = ''
        socket.on('data', d => { text += d.toString('latin1'); if (text.includes('\r\n\r\n')) resolve(text) })
      })
      socket.write(
        `POST /share/${uploadKey}/upload?filename=huge.png HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        'Content-Type: image/png\r\n' +
        `Content-Length: ${(c.maxFileMb as number + 5) * 1024 * 1024}\r\n\r\n`
      )
      try {
        const head = await reply
        expect(head).toMatch(/^HTTP\/1\.1 413/)
        expect(head.toLowerCase()).toContain('connection: close')
      } finally {
        socket.destroy()
      }
    }, 60000)

    sizeIt('does not file an oversize upload in the album', async () => {
      const before = (await fx.albumAssetIds(albumId)).length
      const big = makePngOfAtLeast((c.maxFileMb as number) * 1024 * 1024 + 512 * 1024)
      await upload(U, `/share/${uploadKey}`, big, { filename: 'must-not-land.png', createdAt: CREATED_AT }).catch(() => undefined)
      expect((await fx.albumAssetIds(albumId)).length).toBe(before)
    }, 120000)

    it('keeps serving after a rejection', async () => {
      for (let i = 0; i < 3; i++) {
        const rejected = await upload(U, `/share/${uploadKey}`, makePng(20, 20), {
          filename: 'x.zip', contentType: 'application/zip', createdAt: CREATED_AT
        })
        expect(rejected.status).toBe(415)
        const accepted = await upload(U, `/share/${uploadKey}`, makePng(30, 30, false, 200 + i), {
          filename: unique(`after-reject-${i}`), createdAt: CREATED_AT
        })
        expect(accepted.status).toBe(200)
      }
    }, 120000)
  })

  describe('the asset cap and both cached identities', () => {
    const slugIt = c.uploadSlugUrl ? it : it.skip

    slugIt('counts an upload through the slug against the canonical key at once', async () => {
      /*
        The upload-slug service allows slug writes and caps albums at 3. Both
        identities of the share are warmed in its 60 s cache, three files go
        in through the slug, and the fourth, through the canonical key, must
        be refused as album-full at once: it can only be if the upload dropped
        the canonical key's cached count as well as the slug's.
      */
      const base = c.uploadSlugUrl as string
      const slug = `zz-ipp-e2e-cap-${Date.now()}`
      const album = await fx.createAlbum('cap')
      const link = await fx.createShareLink(album, { allowUpload: true, slug })
      expect(link.slug).toBe(slug)
      expect(link.key).not.toBe(slug)

      expect((await fetch(`${base}/s/${slug}`)).status).toBe(200)
      expect((await fetch(`${base}/share/${link.key}`)).status).toBe(200)

      for (let i = 0; i < 3; i++) {
        const res = await upload(base, `/s/${slug}`, makePng(30 + i, 20, false, 600 + i), { filename: unique(`cap-${i}`), createdAt: CREATED_AT })
        expect(res.status).toBe(200)
      }
      const fourth = await upload(base, `/share/${link.key}`, makePng(40, 20, false, 699), { filename: unique('cap-4'), createdAt: CREATED_AT })
      expect(fourth.status, 'the canonical key still saw the stale count').toBe(403)
      expect((await fourth.json() as { reason: string }).reason).toBe('album-full')
      expect((await fx.albumAssetIds(album)).length).toBe(3)
    }, 120000)
  })

  describe('duplicate pre-check', () => {
    const check = (key: string, checksum: string) => fetch(`${U}/share/${key}/check`, {
      method: 'POST', headers: { 'X-IPP-Checksum': checksum }
    })

    it('reports a duplicate for content this share already shows, without its id', async () => {
      const bytes = makePng(130, 100, false, 808)
      const up = await upload(U, `/share/${uploadKey}`, bytes, { filename: unique('precheck-seed'), createdAt: CREATED_AT })
      expect(up.status).toBe(200)

      const res = await check(uploadKey, createHash('sha1').update(bytes).digest('base64'))
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({ duplicate: true, checked: true })
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
    }, 90000)

    it('reports a miss as checked, not as unavailable', async () => {
      const res = await check(uploadKey, createHash('sha1').update(makePng(17, 13, true, 4242)).digest('base64'))
      expect(await res.json()).toEqual({ duplicate: false, checked: true })
    }, 60000)

    it('does NOT reveal content the owner holds outside this share, nor file it there', async () => {
      const otherAlbum = await fx.createAlbum('elsewhere')
      const otherLink = await fx.createShareLink(otherAlbum, { allowUpload: true })
      const secret = makePng(140, 110, true, 909)
      const up = await upload(U, `/share/${otherLink.key}`, secret, { filename: unique('elsewhere'), createdAt: CREATED_AT })
      expect(up.status).toBe(200)

      const before = (await fx.albumAssetIds(albumId)).length
      const res = await check(uploadKey, createHash('sha1').update(secret).digest('base64'))
      expect(res.status).toBe(200)
      expect(await res.json(), 'the check leaked a file held outside this share').toEqual({ duplicate: false, checked: true })
      expect((await fx.albumAssetIds(albumId)).length, 'the probe filed the asset into the album').toBe(before)
    }, 120000)

    it('refuses anything that is not a base64 SHA-1', async () => {
      for (const bad of ['', 'not-a-checksum', 'A'.repeat(64), '../../etc']) {
        expect((await check(uploadKey, bad)).status, `accepted ${JSON.stringify(bad)}`).toBe(400)
      }
    }, 60000)

    it('is refused on a link that may not upload', async () => {
      const sha1 = createHash('sha1').update(makePng(20, 20)).digest('base64')
      expect((await check(noUploadKey, sha1)).status).toBe(404)
      const forever = await fx.createShareLink(albumId, { allowUpload: true, expiresInDays: null })
      const res = await check(forever.key, sha1)
      expect(res.status).toBe(403)
      expect((await res.json() as { reason: string }).reason).toBe('no-expiry')
    }, 60000)
  })

  describe('password-protected shares', () => {
    const PASSWORD = 'e2e-correct-horse'

    it('refuses an upload without the unlock cookie', async () => {
      const link = await fx.createShareLink(albumId, { allowUpload: true, password: PASSWORD })
      const res = await upload(U, `/share/${link.key}`, makePng(20, 20), { filename: 'locked.png', createdAt: CREATED_AT })
      expect(res.status).toBe(404)
    }, 60000)

    it('accepts an upload once unlocked on the upload service', async () => {
      const link = await fx.createShareLink(albumId, { allowUpload: true, password: PASSWORD })
      const cookie = await unlockShare(U, link.key, PASSWORD)
      const name = unique('unlocked')
      const res = await upload(U, `/share/${link.key}`, makePng(50, 40, false, 41), { filename: name, createdAt: CREATED_AT, cookie })
      expect(res.status).toBe(200)
      expect(await fx.findInAlbum(albumId, STORED_PREFIX + name)).toBeDefined()
    }, 90000)

    it('refuses an upload carrying a cookie unlocked with the wrong password', async () => {
      const link = await fx.createShareLink(albumId, { allowUpload: true, password: PASSWORD })
      const cookie = await unlockShare(U, link.key, 'not-the-password')
      const res = await upload(U, `/share/${link.key}`, makePng(20, 20), { filename: 'wrong.png', createdAt: CREATED_AT, cookie })
      expect(res.status).toBe(404)
    }, 60000)
  })

  describe('a connection that stops existing', () => {
    /*
      The admission slot is released when the handler settles. A visitor
      whose connection simply stops sends no FIN, and the round trip to
      Immich has no deadline of its own: only a time bound gives that slot
      back. upload-reap has maxConcurrent 1, so one stalled socket exhausts
      it, and a 10 s idle bound, so recovery is observable in seconds.
    */
    const onReap = it.skipIf(!c.uploadReapUrl)

    onReap('gives its admission slot back instead of holding it for good', async () => {
      const reap = c.uploadReapUrl as string
      const url = new URL(reap)
      const link = await fx.createShareLink(albumId, { allowUpload: true })

      const attempt = async () => {
        const res = await upload(reap, `/share/${link.key}`, makePng(24, 24, true, Date.now() % 1000), {
          filename: unique('probe'), createdAt: CREATED_AT
        })
        await res.text().catch(() => '')
        return res.status
      }

      // Headers and a few bytes, then silence, the socket held open
      const stalled = net.createConnection({ host: url.hostname, port: Number(url.port) })
      await new Promise<void>((resolve, reject) => {
        stalled.once('connect', () => resolve())
        stalled.once('error', reject)
      })
      stalled.write(
        `POST /share/${link.key}/upload?filename=stalled.png&fileCreatedAt=${encodeURIComponent(CREATED_AT)} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        'Content-Type: image/png\r\n' +
        // Under maxFileSize, or it is refused before it takes a slot
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
      The counters and levels are unit-tested; this proves the wiring: a real
      upload through the real route reaches the real log, within one window.
    */
    const exec = promisify(execFile)
    const CONTAINER = process.env.E2E_UPLOAD_CONTAINER || 'ipp-test-stack-upload-1'

    const containerLog = async (): Promise<string | null> => {
      try {
        const { stdout, stderr } = await exec('docker', ['logs', CONTAINER])
        return stdout + stderr
      } catch {
        return null
      }
    }

    it('records a successful upload in the summary, and nothing the visitor sent', async () => {
      const before = await containerLog()
      if (before === null) {
        console.warn(`skipped: cannot read logs for container ${CONTAINER}`)
        return
      }
      const baseline = before.split('\n').filter(l => l.includes('Guest upload |')).length
      const name = unique('reported')
      const res = await upload(U, `/share/${uploadKey}`, makePng(30, 30, true, 77), { filename: name, createdAt: CREATED_AT, uploader: 'Jane Doe' })
      expect(res.status).toBe(200)

      let line: string | undefined
      const appeared = await eventually(async () => {
        const lines = ((await containerLog()) || '').split('\n').filter(l => l.includes('Guest upload |'))
        if (lines.length <= baseline) return false
        line = lines.slice(baseline).find(l => /created=[1-9]/.test(l))
        return !!line
      }, 90000, 2000)
      expect(appeared, 'a successful upload still produced no log line').toBe(true)

      const all = (await containerLog()) || ''
      for (const secret of [name, 'jane-doe', 'Jane Doe', uploadKey]) {
        expect(all, `the log carries ${secret}`).not.toContain(secret)
      }
    }, 120000)
  })

  describe('capture date', () => {
    const CAMERA: Array<[number, string]> = [[TAG.make, 'Google'], [TAG.model, 'Pixel 8a']]

    const uploadAndRead = async (body: Buffer, stem: string) => {
      const name = unique(stem, 'jpg')
      const res = await upload(U, `/share/${uploadKey}`, body, { filename: name, createdAt: CREATED_AT, contentType: 'image/jpeg' })
      expect(res.status).toBe(200)
      const out = await res.json() as { status: string, dateSource?: string }
      const asset = await fx.findInAlbum(albumId, STORED_PREFIX + name)
      expect(asset).toBeDefined()
      return { ...out, detail: await fx.assetDetail(asset!.id) }
    }

    it('dates the asset from the file, not from when it was uploaded', async () => {
      const out = await uploadAndRead(jpegWithExif(CAMERA, [[TAG.dateTimeOriginal, '2026:03:04 09:15:00']]), 'has-capture-date')
      expect(out.dateSource).toBe('exif-original')
      expect(out.detail.fileCreatedAt.slice(0, 10)).toBe('2026-03-04')
    }, 60000)

    it('salvages DateTime, which Immich alone would have ignored', async () => {
      const out = await uploadAndRead(jpegWithExif([...CAMERA, [TAG.modifyDate, '2026:02:01 21:13:07']]), 'only-modify-date')
      expect(out.dateSource).toBe('exif-modify')
      expect(out.detail.fileCreatedAt.slice(0, 10)).toBe('2026-02-01')
    }, 60000)

    it('tells the visitor when the file carried no date at all', async () => {
      const out = await uploadAndRead(jpegWithoutExif(), 'no-exif')
      expect(out.dateSource, 'the visitor must be told the date is a guess').toBe('client')
      expect(out.detail.fileCreatedAt.slice(0, 10)).toBe(CREATED_AT.slice(0, 10))
    }, 60000)
  })
})
