/*
End-to-end helpers: fixtures created in a REAL Immich instance, exercised
through a REAL deployed IPP.

These tests are opt-in. They need three things that unit tests deliberately do
not have - a live Immich, an API key with permission to create and delete
albums, shared links and assets, and a running IPP pointed at that Immich. See
`docs/config/upload.md` and `npm run test:e2e`.

Everything created here is named with the `E2E_PREFIX` and torn down in
`afterAll`, including a force-delete of uploaded assets so nothing is left in
the trash.
*/

import zlib from 'zlib'

export interface E2EConfig {
  immichUrl: string
  apiKey: string
  ippUrl: string
  /** The instance's configured ipp.upload.maxFileSizeMb, when known. */
  maxFileMb?: number
  /** The instance's configured ipp.upload.maxConcurrent. */
  maxConcurrent: number
  /** A second proxy that permits writes through a slug link, if available. */
  ippSlugUrl?: string
}

export const E2E_PREFIX = 'zz-ipp-e2e'

/**
 * Read the environment contract. Returns null when the suite should be
 * skipped, so a plain `npm test` on a laptop never tries to reach a server.
 */
export function readConfig (): E2EConfig | null {
  const immichUrl = process.env.E2E_IMMICH_URL
  const apiKey = process.env.E2E_IMMICH_API_KEY
  const ippUrl = process.env.E2E_IPP_URL
  if (!immichUrl || !apiKey || !ippUrl) return null
  const rawMax = Number(process.env.E2E_UPLOAD_MAX_MB)
  return {
    immichUrl: immichUrl.replace(/\/+$/, ''),
    apiKey,
    ippUrl: ippUrl.replace(/\/+$/, ''),
    // Guard the upper bound: the size test has to generate maxFileMb + 1
    // megabytes, and nobody wants a 200 MB buffer in a test run.
    maxFileMb: Number.isFinite(rawMax) && rawMax > 0 && rawMax <= 8 ? rawMax : undefined,
    maxConcurrent: Math.max(1, Number(process.env.E2E_UPLOAD_MAX_CONCURRENT) || 2),
    ippSlugUrl: process.env.E2E_IPP_SLUG_URL?.replace(/\/+$/, '')
  }
}

/* ---------------------------------------------------------------- Immich */

export class ImmichFixtures {
  private readonly cfg: E2EConfig
  private readonly albums: string[] = []
  private readonly links: string[] = []
  private readonly assets: string[] = []

  constructor (cfg: E2EConfig) {
    this.cfg = cfg
  }

  private async api (path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.cfg.immichUrl + '/api' + path, {
      ...init,
      headers: {
        'x-api-key': this.cfg.apiKey,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {})
      }
    })
  }

  private async json<T> (path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.api(path, init)
    if (!res.ok) {
      throw new Error(`Immich ${init.method || 'GET'} ${path} -> ${res.status}: ${await res.text()}`)
    }
    return await res.json() as T
  }

  async createAlbum (suffix: string): Promise<string> {
    const album = await this.json<{ id: string }>('/albums', {
      method: 'POST',
      body: JSON.stringify({ albumName: `${E2E_PREFIX}-${suffix}-${Date.now()}` })
    })
    this.albums.push(album.id)
    return album.id
  }

  /**
   * Upload-enabled links get an expiry by default, because the fork refuses
   * to write through a link that has none (see ipp.upload.requireExpiry).
   * Pass `expiresInDays` to exercise the horizon, or `null` to omit it.
   */
  async createShareLink (albumId: string, opts: {
    allowUpload?: boolean
    password?: string
    slug?: string
    expiresInDays?: number | null
  } = {}): Promise<{ id: string, key: string, slug: string | null }> {
    const days = opts.expiresInDays === undefined ? 7 : opts.expiresInDays
    const expiresAt = days === null
      ? undefined
      : new Date(Date.now() + days * 86400_000).toISOString()
    const link = await this.json<{ id: string, key: string, slug: string | null }>('/shared-links', {
      method: 'POST',
      body: JSON.stringify({
        type: 'ALBUM',
        albumId,
        allowUpload: opts.allowUpload ?? false,
        ...(expiresAt ? { expiresAt } : {}),
        ...(opts.password ? { password: opts.password } : {}),
        ...(opts.slug ? { slug: opts.slug } : {})
      })
    })
    this.links.push(link.id)
    return link
  }

  /** Album assets are not in AlbumResponseDto since Immich 3.0 - use search. */
  async albumAssetIds (albumId: string): Promise<string[]> {
    const res = await this.json<{ assets: { items: { id: string }[] } }>('/search/metadata', {
      method: 'POST',
      body: JSON.stringify({ albumIds: [albumId], size: 200 })
    })
    return res.assets.items.map(a => a.id)
  }

  async assetDetail (id: string): Promise<{ originalFileName: string, fileCreatedAt: string }> {
    return await this.json(`/assets/${id}`)
  }

  /** Track an asset created through IPP so teardown can hard-delete it. */
  track (assetId: string): void {
    this.assets.push(assetId)
  }

  /**
   * Remove everything this run created. Best-effort and order-sensitive:
   * assets first (force, so they skip the trash), then links, then albums.
   */
  async teardown (): Promise<string[]> {
    const problems: string[] = []
    // Sweep album contents too - a test may have uploaded without tracking.
    for (const albumId of this.albums) {
      try {
        for (const id of await this.albumAssetIds(albumId)) {
          if (!this.assets.includes(id)) this.assets.push(id)
        }
      } catch (e) { problems.push(`sweep ${albumId}: ${String(e)}`) }
    }
    if (this.assets.length) {
      try {
        const res = await this.api('/assets', {
          method: 'DELETE',
          body: JSON.stringify({ ids: this.assets, force: true })
        })
        if (!res.ok) problems.push(`delete assets -> ${res.status}`)
      } catch (e) { problems.push(`delete assets: ${String(e)}`) }
    }
    for (const id of this.links) {
      try { await this.api(`/shared-links/${id}`, { method: 'DELETE' }) } catch (e) { problems.push(`link ${id}`) }
    }
    for (const id of this.albums) {
      try { await this.api(`/albums/${id}`, { method: 'DELETE' }) } catch (e) { problems.push(`album ${id}`) }
    }
    return problems
  }
}

/* ------------------------------------------------------------------- IPP */

export interface UploadHeaders {
  filename?: string
  createdAt?: string
  contentType?: string
  cookie?: string
  chunked?: boolean
}

/**
 * POST a file to IPP's upload route the way the browser client does: raw body,
 * metadata in headers.
 *
 * `chunked` drops Content-Length so the request goes up with chunked transfer
 * encoding - that is the path where the declared-size pre-check cannot help
 * and the mid-stream byte count is the only thing enforcing the cap.
 */
export async function uploadToIpp (
  cfg: E2EConfig,
  sharePath: string,
  body: Buffer,
  headers: UploadHeaders = {}
): Promise<Response> {
  const h: Record<string, string> = {
    'Content-Type': headers.contentType ?? 'image/png'
  }
  if (headers.filename !== undefined) h['X-IPP-Filename'] = encodeURIComponent(headers.filename)
  if (headers.createdAt !== undefined) h['X-IPP-Created-At'] = headers.createdAt
  if (headers.cookie) h.Cookie = headers.cookie

  const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers: h }
  if (headers.chunked) {
    // A stream body with no Content-Length makes undici use chunked encoding.
    init.body = new ReadableStream({
      start (controller) {
        controller.enqueue(new Uint8Array(body))
        controller.close()
      }
    })
    init.duplex = 'half'
  } else {
    init.body = new Uint8Array(body)
  }
  return fetch(`${cfg.ippUrl}${sharePath}/upload`, init)
}

/**
 * Upload a body that dribbles out over time, so the server genuinely holds
 * its admission slot for a known duration. A buffer on loopback finishes too
 * fast for concurrency to be observable at all.
 */
export function uploadSlowToIpp (
  cfg: E2EConfig,
  sharePath: string,
  body: Buffer,
  opts: { chunks?: number, delayMs?: number } & UploadHeaders = {}
): Promise<Response> {
  const chunks = opts.chunks ?? 8
  const delayMs = opts.delayMs ?? 250
  const size = Math.ceil(body.length / chunks)
  let sent = 0

  const stream = new ReadableStream<Uint8Array>({
    async pull (controller) {
      if (sent >= body.length) { controller.close(); return }
      await new Promise(resolve => setTimeout(resolve, delayMs))
      controller.enqueue(new Uint8Array(body.subarray(sent, sent + size)))
      sent += size
    }
  })

  const h: Record<string, string> = { 'Content-Type': opts.contentType ?? 'image/png' }
  if (opts.filename !== undefined) h['X-IPP-Filename'] = encodeURIComponent(opts.filename)
  if (opts.createdAt !== undefined) h['X-IPP-Created-At'] = opts.createdAt
  if (opts.cookie) h.Cookie = opts.cookie

  return fetch(`${cfg.ippUrl}${sharePath}/upload`, {
    method: 'POST', headers: h, body: stream, duplex: 'half'
  } as RequestInit & { duplex: 'half' })
}

/** Unlock a password-protected share and return the cookie header to replay. */
export async function unlockShare (cfg: E2EConfig, key: string, password: string): Promise<string> {
  const res = await fetch(`${cfg.ippUrl}/share/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, password })
  })
  if (!res.ok) throw new Error(`unlock -> ${res.status}`)
  const raw = res.headers.getSetCookie?.() ?? []
  if (!raw.length) throw new Error('unlock returned no Set-Cookie')
  // cookie-session splits the payload across `session` and `session.sig`;
  // both must travel back or the signature check fails.
  return raw.map(c => c.split(';')[0]).join('; ')
}

/* ---------------------------------------------------------------- assets */

/**
 * Build a valid PNG of the requested size, with no image library. Immich
 * sniffs the real type, so a fabricated header over random bytes gets
 * rejected as "Unsupported file type upload" - it has to be a real image.
 *
 * `noisy` fills with incompressible data, which is how the payload is grown
 * to a target byte size for the file-size cap test.
 */
export function makePng (width: number, height: number, noisy = false, seed = 1): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let rnd = seed >>> 0
  const next = () => {
    // xorshift32: deterministic, so a failing run is reproducible.
    rnd ^= rnd << 13; rnd >>>= 0
    rnd ^= rnd >> 17
    rnd ^= rnd << 5; rnd >>>= 0
    return rnd & 0xff
  }
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      if (noisy) {
        raw[o++] = next(); raw[o++] = next(); raw[o++] = next()
      } else {
        raw[o++] = (x * 3) & 0xff; raw[o++] = (y * 5) & 0xff; raw[o++] = 140
      }
    }
  }
  const chunk = (tag: string, data: Buffer): Buffer => {
    const tagBuf = Buffer.from(tag, 'ascii')
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([tagBuf, data])) >>> 0)
    return Buffer.concat([len, tagBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit, truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: noisy ? 0 : 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** A PNG of at least `bytes`, grown with incompressible noise. */
export function makePngOfAtLeast (bytes: number): Buffer {
  // level 0 deflate on noise is ~1 byte per byte, plus 3 bytes per pixel.
  const pixels = Math.ceil(bytes / 3) + 1024
  const width = 1024
  const height = Math.ceil(pixels / width)
  const png = makePng(width, height, true)
  if (png.length < bytes) throw new Error(`generated ${png.length} < ${bytes}`)
  return png
}

/** Poll until `fn` returns true, for Immich's asynchronous processing. */
export async function eventually (fn: () => Promise<boolean>, timeoutMs = 30000, stepMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}
