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
 * Capture what uploadAsset actually puts on the wire. Returns the decoded
 * multipart body so tests can assert on the exact fields Immich would see.
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

describe('canUpload gating', () => {
  beforeEach(() => loadConfig())

  it('is closed by default even when Immich allows upload', () => {
    // ipp.upload.enabled defaults to false: a stock deploy stays read-only.
    expect(canUpload(share({ allowUpload: true }))).toBe(false)
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
    // The closing boundary is never written, so Immich discards the part.
    if (calls.length) expect(calls[0].body).not.toContain('--\r\n--')
  })

  it('reports rejection without surfacing Immich\'s error body', async () => {
    captureFetch({ message: 'Invalid share key' }, false)
    const outcome = await uploadAsset(request())
    expect(outcome).toEqual({ ok: false, reason: 'rejected' })
  })
})
