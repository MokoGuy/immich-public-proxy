import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Readable } from 'stream'
import { sanitiseFilename, uploadAsset } from '../src/stream/upload'
import { canUpload } from '../src/share'
import { AlbumType, KeyType, SharedLink } from '../src/types'
import { loadConfig } from '../src/config/loader'

process.env.IMMICH_URL = 'http://immich.test'

afterEach(() => {
  vi.unstubAllGlobals()
})

function share (over: Partial<SharedLink> = {}): SharedLink {
  return {
    key: 'canonical',
    keyType: KeyType.key,
    type: AlbumType.album,
    assets: [],
    expiresAt: null,
    ...over
  } as SharedLink
}

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
  const calls: { url: string, init: RequestInit & { body?: unknown }, body: string }[] = []
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
    calls.push({ url, init, body: Buffer.concat(chunks).toString('utf8') })
    return {
      ok,
      status: ok ? 201 : 400,
      json: async () => response,
      text: async () => JSON.stringify(response)
    }
  })
  return calls
}

function request (over: Record<string, unknown> = {}) {
  return {
    key: 'submitted-key',
    keyType: KeyType.key,
    filename: 'holiday.jpg',
    contentType: 'image/jpeg',
    createdAt: '2026-09-20T10:00:00.000Z',
    body: Readable.from([Buffer.from('JPEGBYTES')]),
    maxBytes: 1024,
    ...over
  } as Parameters<typeof uploadAsset>[0]
}

/** Load a config with uploads switched on at the instance level. */
function withUploadsEnabled (): void {
  process.env.CONFIG = JSON.stringify({ ipp: { upload: { enabled: true } } })
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
    expect(canUpload(share({ allowUpload: true }))).toBe(false)
  })

  it('stays closed for a link without allowUpload once the instance opts in', () => {
    withUploadsEnabled()
    expect(canUpload(share({ allowUpload: false }))).toBe(false)
    expect(canUpload(share({}))).toBe(false)
  })

  it('opens only when both gates are open', () => {
    withUploadsEnabled()
    expect(canUpload(share({ allowUpload: true }))).toBe(true)
  })

  it('refuses an individual share even with both gates open', () => {
    withUploadsEnabled()
    expect(canUpload(share({ allowUpload: true, type: AlbumType.individual }))).toBe(false)
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
    expect(body).toContain('JPEGBYTES')
    // Nothing else: an uploader cannot reach the rest of AssetMediaCreateDto.
    expect(body.match(/Content-Disposition: form-data; name="/g)).toHaveLength(5)
    // The SUBMITTED key is what authorises the call.
    expect(url).toContain('key=submitted-key')
  })

  it('addresses a slug share with slug=, not key=', async () => {
    const calls = captureFetch()
    await uploadAsset(request({ key: 'my-slug', keyType: KeyType.slug }))
    expect(calls[0].url).toContain('slug=my-slug')
    expect(calls[0].url).not.toContain('key=my-slug')
  })

  it('aborts mid-stream when the file exceeds maxBytes', async () => {
    const calls = captureFetch()
    const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600)])
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
    const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600)])
    const outcome = await uploadAsset(request({ body: big, maxBytes: 1000 }))
    expect(outcome).toEqual({ ok: false, reason: 'too-large' })
  })

  it('reports rejection without surfacing Immich\'s error body', async () => {
    captureFetch({ message: 'Invalid share key' }, false)
    const outcome = await uploadAsset(request())
    expect(outcome).toEqual({ ok: false, reason: 'rejected' })
  })
})
