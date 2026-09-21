import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Readable } from 'stream'
import { ensureExtension, sanitiseFilename, uploadAsset } from '../src/stream/upload'
import { canUpload, uploadRefusal } from '../src/share'
import { sourceLabel, sourceUrl } from '../src/source'
import { AlbumType, KeyType, SharedLink } from '../src/types'
import { loadConfig } from '../src/config/loader'

process.env.IMMICH_URL = 'http://immich.test'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A share that satisfies every condition, so each test can break exactly one. */
function share (over: Partial<SharedLink> = {}): SharedLink {
  return {
    key: 'canonical',
    keyType: KeyType.key,
    type: AlbumType.album,
    assets: [],
    allowUpload: true,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    ...over
  } as SharedLink
}

const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString()

/**
 * Capture what uploadAsset puts on the wire.
 *
 * This is a stub, NOT a faithful undici: it always drains the whole request
 * body before responding, ignores the abort signal, and surfaces stream errors
 * directly instead of wrapping them in `TypeError('fetch failed')`. It is
 * therefore adequate for asserting the multipart IPP generates, and NOT
 * adequate for cancellation, early-rejection or backpressure behaviour - those
 * need a real local HTTP server and are not covered here.
 */
function captureFetch (response: unknown = { id: 'new-asset', status: 'created' }, ok = true) {
  const calls: { url: string, init: RequestInit & { body?: unknown }, body: string, raw: Buffer }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit & { body?: unknown }) => {
    // Drain the streaming request body the same way undici would.
    const chunks: Buffer[] = []
    const web = init.body as ReadableStream<Uint8Array>
    const reader = web.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
    const raw = Buffer.concat(chunks)
    // `body` for the text assertions, `raw` for the ones about actual bytes.
    calls.push({ url, init, body: raw.toString('utf8'), raw })
    return {
      ok,
      status: ok ? 201 : 400,
      json: async () => response,
      text: async () => JSON.stringify(response)
    }
  })
  return calls
}

/**
 * Bytes that pass the magic-byte check for the declared type. The sniffer
 * reads the first 16, so a fixture has to actually look like a JPEG now -
 * "JPEGBYTES" no longer does.
 */
function jpegBytes (size = 32): Buffer {
  const b = Buffer.alloc(Math.max(16, size), 0x20)
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff
  return b
}

function request (over: Record<string, unknown> = {}) {
  return {
    key: 'submitted-key',
    keyType: KeyType.key,
    filename: 'holiday.jpg',
    contentType: 'image/jpeg',
    createdAt: '2026-09-20T10:00:00.000Z',
    body: Readable.from([jpegBytes()]),
    maxBytes: 1024,
    ...over
  } as Parameters<typeof uploadAsset>[0]
}

/** Load a config with uploads on, plus any per-test overrides. */
function withUploadsEnabled (over: Record<string, unknown> = {}): void {
  process.env.CONFIG = JSON.stringify({ ipp: { upload: { enabled: true, ...over } } })
  loadConfig()
}

describe('canUpload gating', () => {
  beforeEach(() => {
    delete process.env.CONFIG
    loadConfig()
  })

  afterEach(() => {
    delete process.env.CONFIG
    loadConfig()
  })

  it('is closed by default even when Immich allows upload', () => {
    // ipp.upload.enabled defaults to false: a stock deploy stays read-only.
    expect(canUpload(share())).toBe(false)
  })

  it('stays closed for a link without allowUpload once the instance opts in', () => {
    withUploadsEnabled()
    expect(canUpload(share({ allowUpload: false }))).toBe(false)
    expect(canUpload(share({ allowUpload: undefined }))).toBe(false)
  })

  it('opens when every condition holds', () => {
    withUploadsEnabled()
    expect(canUpload(share())).toBe(true)
  })

  it('refuses an individual share', () => {
    withUploadsEnabled()
    expect(canUpload(share({ type: AlbumType.individual }))).toBe(false)
  })

  it('names the reason, so the client can explain it', () => {
    // A bare boolean cannot distinguish "the album filled up while you were
    // choosing photos" from "this link never accepted uploads".
    withUploadsEnabled()
    expect(uploadRefusal(share())).toBe(null)
    expect(uploadRefusal(share({ expiresAt: null }))).toBe('no-expiry')
    expect(uploadRefusal(share({ expiresAt: inDays(-1) }))).toBe('expired')
    expect(uploadRefusal(share({ expiresAt: inDays(99) }))).toBe('expiry-too-far')
    expect(uploadRefusal(share({ keyType: KeyType.slug }))).toBe('slug')
    expect(uploadRefusal(share({ allowUpload: false }))).toBe('not-allowed')
    expect(uploadRefusal(share({ type: AlbumType.individual }))).toBe('not-album')
    withUploadsEnabled({ maxAssets: 1 })
    expect(uploadRefusal(share({ assets: [{ id: 'a' }] as never }))).toBe('album-full')
  })

  it('requirePassword is off by default and enforceable when wanted', () => {
    withUploadsEnabled()
    expect(canUpload(share())).toBe(true)
    withUploadsEnabled({ requirePassword: true })
    expect(uploadRefusal(share())).toBe('no-password')
    expect(canUpload(share({ password: 'set' }))).toBe(true)
  })

  it('refuses a slug link: readable means guessable', () => {
    withUploadsEnabled()
    expect(canUpload(share({ keyType: KeyType.slug }))).toBe(false)
  })

  it('allows a slug link when the operator turns that requirement off', () => {
    withUploadsEnabled({ requireRandomKey: false })
    expect(canUpload(share({ keyType: KeyType.slug }))).toBe(true)
  })

  it('refuses a link with no expiry', () => {
    // An upload capability you cannot retract, because you cannot know who
    // copied the URL.
    withUploadsEnabled()
    expect(canUpload(share({ expiresAt: null }))).toBe(false)
  })

  it('refuses an expiry beyond the configured horizon', () => {
    withUploadsEnabled()
    expect(canUpload(share({ expiresAt: inDays(31) }))).toBe(false)
    expect(canUpload(share({ expiresAt: inDays(29) }))).toBe(true)
  })

  it('refuses an already-expired link', () => {
    withUploadsEnabled()
    expect(canUpload(share({ expiresAt: inDays(-1) }))).toBe(false)
  })

  it('honours a custom horizon, and 0 meaning no horizon', () => {
    withUploadsEnabled({ maxExpiryDays: 90 })
    expect(canUpload(share({ expiresAt: inDays(60) }))).toBe(true)
    withUploadsEnabled({ maxExpiryDays: 0 })
    expect(canUpload(share({ expiresAt: inDays(3650) }))).toBe(true)
  })

  it('refuses once the album has reached the cumulative ceiling', () => {
    // The size cap bounds one file; this bounds the total. Without it a
    // leaked link is limited only by free disk.
    withUploadsEnabled({ maxAssets: 3 })
    const assets = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }))
    expect(canUpload(share({ assets: assets(2) as never }))).toBe(true)
    expect(canUpload(share({ assets: assets(3) as never }))).toBe(false)
    expect(canUpload(share({ assets: assets(9) as never }))).toBe(false)
  })

  it('treats maxAssets 0 as no ceiling', () => {
    withUploadsEnabled({ maxAssets: 0 })
    const assets = Array.from({ length: 5000 }, (_, i) => ({ id: String(i) }))
    expect(canUpload(share({ assets: assets as never }))).toBe(true)
  })
})

describe('AGPL section 13 source offer', () => {
  beforeEach(() => {
    delete process.env.CONFIG
    loadConfig()
  })

  it('points at the running revision, not at a moving branch', () => {
    // Section 13 asks for the source of the version actually running.
    expect(sourceUrl()).toContain('/tree/')
  })

  it('names the product so the offer is recognisable', () => {
    // Shape only - tests/sourceLabel.test.ts covers version and build date.
    expect(sourceLabel()).toMatch(/^IPP\b/)
  })

  it('can be repointed so a fork of this fork offers its own source', () => {
    process.env.CONFIG = JSON.stringify({ ipp: { sourceUrl: 'https://example.test/me/ipp/' } })
    loadConfig()
    expect(sourceUrl()).toContain('https://example.test/me/ipp/tree/')
    expect(sourceUrl()).not.toContain('//tree')
  })
})

describe('sanitiseFilename', () => {
  it('strips quotes and CRLF so the part header cannot be injected', () => {
    const out = sanitiseFilename('ev"il\r\nContent-Type: text/html\r\n\r\n.jpg')
    expect(out).not.toMatch(/["\r\n]/)
  })

  it('drops path components', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitiseFilename('C:\\windows\\evil.jpg')).toBe('evil.jpg')
  })

  it('never returns empty', () => {
    expect(sanitiseFilename('')).toBe('upload')
    expect(sanitiseFilename('///')).toBe('upload')
  })

  it('decodes the percent-encoding the client applies', () => {
    expect(sanitiseFilename(encodeURIComponent('holiday photo.jpg'))).toBe('holiday photo.jpg')
    expect(sanitiseFilename(encodeURIComponent('été à Pézac.jpg'))).toBe('été à Pézac.jpg')
  })

  it('survives a malformed percent sequence instead of dropping the upload', () => {
    expect(sanitiseFilename('100%-real.jpg')).toBe('100%-real.jpg')
  })

  it('keeps the extension when truncating a very long name', () => {
    const out = sanitiseFilename('a'.repeat(400) + '.jpg')
    expect(out.endsWith('.jpg')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(255)
  })

  it('decodes before sanitising, so encoded control characters are still stripped', () => {
    expect(sanitiseFilename('bad%0D%0AX-Evil: 1.jpg')).not.toMatch(/[\r\n]/)
  })
})

describe('ensureExtension', () => {
  // Immich answers 400 "Unsupported file type upload" for an extensionless
  // name, so this is what stands between a header-less client and a failure.
  it('adds one from the content type when the name has none', () => {
    expect(ensureExtension('upload', 'image/jpeg')).toBe('upload.jpg')
    expect(ensureExtension('upload', 'image/png')).toBe('upload.png')
    expect(ensureExtension('upload', 'video/quicktime')).toBe('upload.mov')
  })

  it('falls back to the mime subtype for unmapped types', () => {
    expect(ensureExtension('upload', 'image/bmp')).toBe('upload.bmp')
  })

  it('ignores parameters on the content type', () => {
    expect(ensureExtension('upload', 'image/jpeg; charset=binary')).toBe('upload.jpg')
  })

  it('leaves an existing extension alone', () => {
    expect(ensureExtension('holiday.png', 'image/jpeg')).toBe('holiday.png')
  })

  it('does not invent a bogus extension from a junk type', () => {
    expect(ensureExtension('upload', 'nonsense')).toBe('upload')
  })
})

describe('hostile input', () => {
  // Findings from a red-team pass against the deployed fork. Each of these is
  // something an anonymous visitor holding the share link can actually try.

  it('cannot inject an extra multipart part through the filename', async () => {
    // The payload closes the filename parameter and opens a second part that
    // sets isFavorite. Verified against a live Immich: the name arrives
    // flattened and the injected field never takes effect.
    const calls = captureFetch()
    const evil = 'a.png"\r\n\r\n--X\r\nContent-Disposition: form-data; name="isFavorite"\r\n\r\ntrue\r\n--X\r\nContent-Disposition: form-data; name="b'
    await uploadAsset(request({ filename: encodeURIComponent(evil) }))
    const body = calls[0].body
    // Still exactly the five fields we generate: the payload did not become a
    // sixth part. The words survive INSIDE the quoted filename, harmlessly -
    // what matters is that no CR/LF got through to terminate it.
    expect(body.match(/Content-Disposition: form-data; name="/g)).toHaveLength(5)
    const fileLine = body.split('\r\n').find(l => l.includes('filename='))
    expect(fileLine).toBeTruthy()
    expect(fileLine).toContain('name="assetData"')
    expect(fileLine).not.toMatch(/[\r\n]/)
  })

  it('refuses bytes that do not match the declared content type', async () => {
    // Immich trusts the filename extension and stores whatever it is given,
    // so a ZIP announced as image/png lands in the owner's library. On an
    // anonymous write path that is ours to stop.
    const zip = Buffer.alloc(32, 0x41)
    Buffer.from('PK\x03\x04', 'latin1').copy(zip)
    const calls = captureFetch()
    const outcome = await uploadAsset(request({
      contentType: 'image/png', body: Readable.from([zip])
    }))
    expect(outcome).toEqual({ ok: false, reason: 'not-media' })
    expect(calls).toHaveLength(0)
  })

  it('refuses an empty body rather than relaying a broken upload', async () => {
    const calls = captureFetch()
    const outcome = await uploadAsset(request({ body: Readable.from([]) }))
    expect(outcome).toEqual({ ok: false, reason: 'empty' })
    expect(calls).toHaveLength(0)
  })

  it('checks the signature of a file shorter than the sniff window', async () => {
    // A 4-byte "image" never reaches the 16-byte threshold; the short-file
    // path has to apply the same check rather than waving it through.
    captureFetch()
    const outcome = await uploadAsset(request({
      contentType: 'image/png', body: Readable.from([Buffer.from([1, 2, 3, 4])])
    }))
    expect(outcome).toEqual({ ok: false, reason: 'not-media' })
  })

  it('accepts a short file that does match', async () => {
    const calls = captureFetch()
    const gif = Buffer.from('GIF89a;', 'latin1')
    const outcome = await uploadAsset(request({
      contentType: 'image/gif', filename: 'tiny.gif', body: Readable.from([gif])
    }))
    expect(outcome).toEqual({ ok: true, id: 'new-asset', status: 'created' })
    expect(calls[0].raw.includes(gif)).toBe(true)
  })

  it('lets an unrecognised type through rather than inventing a verdict', async () => {
    // We only refuse when we know the signature and it disagrees. Rejecting
    // formats this table has not heard of would break real uploads.
    const calls = captureFetch()
    const outcome = await uploadAsset(request({
      contentType: 'image/x-unheard-of',
      filename: 'odd.xyz',
      body: Readable.from([Buffer.alloc(32, 0x5a)])
    }))
    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('flattens a traversal filename to its basename', () => {
    expect(sanitiseFilename(encodeURIComponent('../../../../etc/passwd.png'))).toBe('passwd.png')
  })
})

describe('uploadAsset wire format', () => {
  it('sends exactly the fields IPP generates, and the file bytes', async () => {
    const calls = captureFetch()
    const outcome = await uploadAsset(request())

    expect(outcome).toEqual({ ok: true, id: 'new-asset', status: 'created' })
    expect(calls).toHaveLength(1)
    const { body, url } = calls[0]
    // Immich's required fields, all generated server-side.
    expect(body).toContain('name="deviceAssetId"')
    expect(body).toContain('name="deviceId"')
    expect(body).toContain('immich-public-proxy')
    expect(body).toContain('name="fileCreatedAt"')
    expect(body).toContain('name="fileModifiedAt"')
    expect(body).toContain('name="assetData"; filename="holiday.jpg"')
    // The file's own bytes are relayed untouched, not re-encoded.
    expect(calls[0].raw.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true)
    // Nothing else: an uploader cannot reach the rest of AssetMediaCreateDto.
    expect(body.match(/Content-Disposition: form-data; name="/g)).toHaveLength(5)
    // The SUBMITTED key is what authorises the call.
    expect(url).toContain('key=submitted-key')
  })

  it('gives an extensionless filename one, so Immich accepts it', async () => {
    const calls = captureFetch()
    const pngHead = Buffer.alloc(32, 0x20)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHead)
    await uploadAsset(request({ filename: 'upload', contentType: 'image/png', body: Readable.from([pngHead]) }))
    expect(calls[0].body).toContain('filename="upload.png"')
  })

  it('addresses a slug share with slug=, not key=', async () => {
    const calls = captureFetch()
    await uploadAsset(request({ key: 'my-slug', keyType: KeyType.slug }))
    expect(calls[0].url).toContain('slug=my-slug')
    expect(calls[0].url).not.toContain('key=my-slug')
  })

  it('aborts mid-stream when the file exceeds maxBytes', async () => {
    const calls = captureFetch()
    const big = Readable.from([jpegBytes(600), jpegBytes(600)])
    const outcome = await uploadAsset(request({ body: big, maxBytes: 1000 }))
    expect(outcome).toEqual({ ok: false, reason: 'too-large' })
    // The producer threw, so the stub never completed a capture at all - that
    // absence IS the assertion: no complete multipart reached Immich.
    expect(calls).toHaveLength(0)
  })

  it('still reports too-large when fetch wraps the producer error', async () => {
    // Real fetch surfaces a body-iterator failure as TypeError('fetch failed',
    // { cause }), which defeats an `instanceof UploadTooLarge` check. The
    // overflow flag is what makes the outcome survive that wrapping.
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit & { body?: unknown }) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader()
      try {
        for (;;) { const { done } = await reader.read(); if (done) break }
      } catch (e) {
        throw new TypeError('fetch failed', { cause: e })
      }
      return { ok: true, status: 201, json: async () => ({ id: 'x', status: 'created' }), text: async () => '' }
    })
    const big = Readable.from([jpegBytes(600), jpegBytes(600)])
    const outcome = await uploadAsset(request({ body: big, maxBytes: 1000 }))
    expect(outcome).toEqual({ ok: false, reason: 'too-large' })
  })

  it('reports rejection without surfacing Immich\'s error body', async () => {
    captureFetch({ message: 'Invalid share key' }, false)
    const outcome = await uploadAsset(request())
    expect(outcome).toEqual({ ok: false, reason: 'rejected' })
  })
})
