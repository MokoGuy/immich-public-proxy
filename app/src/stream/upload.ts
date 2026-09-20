import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { apiUrl, authHeaders, buildUrl } from '../immich'
import { KeyType } from '../types'
import { log } from '../utils/log'

/**
 * Streaming upload of a single asset into a shared album.
 *
 * Direction of travel is the mirror image of `stream/asset.ts`: there we pipe
 * an Immich response out to the visitor honouring their backpressure; here we
 * pipe the visitor's request body up to Immich without ever staging it in
 * memory or on disk. IPP stays true to "stores nothing" - the bytes pass
 * through.
 *
 * WHY WE BUILD THE MULTIPART BODY OURSELVES
 *
 * The obvious implementation - relay the browser's own multipart body
 * verbatim - is a trap twice over:
 *
 *   1. Immich's `POST /assets` requires specific part names (`assetData`) and
 *      required fields (`deviceAssetId`, `deviceId`, `fileCreatedAt`,
 *      `fileModifiedAt`). A relayed browser form would have to already be in
 *      exactly that shape, which makes the wire format between the gallery
 *      and IPP an undocumented copy of Immich's API.
 *   2. More importantly, `AssetMediaCreateDto` accepts considerably more than
 *      file bytes - sidecar data, visibility, favourite state, live-photo
 *      linkage. Relaying arbitrary visitor-supplied parts would hand an
 *      anonymous uploader control over all of them.
 *
 * So the visitor sends us a *raw body* (the file, nothing else) plus a little
 * metadata in headers, and IPP constructs every field Immich receives. The
 * visitor cannot inject a field we did not put there. Constructing multipart
 * is trivial; parsing it is the part that would need a real dependency, and
 * we avoid it entirely.
 */

export interface UploadRequest {
  /** The key exactly as submitted in the URL - never `SharedLink.key`. */
  key: string
  /** Matching key type for that submitted key (`key` or `slug`). */
  keyType: KeyType
  /** Share password from the session cookie, if the link is protected. */
  password?: string
  filename: string
  contentType: string
  /** ISO 8601 capture time, already validated by the caller. */
  createdAt: string
  /** The visitor's request stream. */
  body: Readable
  maxBytes: number
  /** Fires when the visitor disconnects. */
  signal?: AbortSignal
}

export type UploadOutcome =
  | { ok: true, id: string, status: string }
  | { ok: false, reason: 'too-large' | 'aborted' | 'rejected' | 'error' }

/** Multipart field values we generate; never anything visitor-controlled. */
const DEVICE_ID = 'immich-public-proxy'

/**
 * Strip anything that could break out of the `filename="..."` parameter or
 * smuggle extra headers into the part. Quotes, backslashes and CR/LF are the
 * injection vectors; path separators are dropped so a name like
 * `../../etc/passwd` cannot travel upstream as a path.
 */
export function sanitiseFilename (raw: string): string {
  const base = raw.split(/[\\/]/).pop() || ''
  // Drop every C0/C1 control character (CR and LF among them) plus the two
  // characters that can terminate the quoted filename parameter. Filtering
  // by code point rather than a regex keeps this exhaustive: anything below
  // 0x20 goes, not only the escapes we happened to think of.
  const cleaned = Array.from(base)
    .filter(ch => {
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false
      return ch !== '"' && ch !== '\\'
    })
    .join('')
    .trim()
  return cleaned.slice(0, 255) || 'upload'
}

/**
 * Yield the multipart body: generated text fields, then the visitor's bytes,
 * then the closing boundary. Counting happens here so an over-size upload is
 * cut off mid-stream rather than after we have already relayed it all.
 */
async function * multipartBody (req: UploadRequest, boundary: string): AsyncGenerator<Buffer> {
  const filename = sanitiseFilename(req.filename)
  const field = (name: string, value: string) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)

  yield field('deviceAssetId', randomUUID())
  yield field('deviceId', DEVICE_ID)
  yield field('fileCreatedAt', req.createdAt)
  yield field('fileModifiedAt', req.createdAt)
  yield Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="assetData"; filename="${filename}"\r\n` +
    `Content-Type: ${req.contentType}\r\n\r\n`
  )

  let bytes = 0
  for await (const chunk of req.body) {
    bytes += chunk.length
    if (bytes > req.maxBytes) {
      // Throwing here aborts the request body mid-flight, so Immich sees a
      // broken upload and discards it. Content-Length is not trustworthy for
      // this check - a chunked request simply omits it.
      throw new UploadTooLarge()
    }
    yield chunk
  }

  yield Buffer.from(`\r\n--${boundary}--\r\n`)
}

class UploadTooLarge extends Error {
  constructor () {
    super('Upload exceeded the configured size limit')
    this.name = 'UploadTooLarge'
  }
}

/**
 * Relay one file to Immich. Resolves to a discriminated outcome rather than
 * throwing, so the route can map failures onto IPP's generic responses
 * without leaking Immich's own error body to the visitor.
 */
export async function uploadAsset (req: UploadRequest): Promise<UploadOutcome> {
  const boundary = '----ippUpload' + randomUUID().replace(/-/g, '')
  const url = buildUrl(apiUrl() + '/assets', { [req.keyType]: req.key })
  const headers: Record<string, string> = {
    ...(await authHeaders(req.keyType, req.key, req.password)),
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  }

  const stream = Readable.from(multipartBody(req, boundary))
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      signal: req.signal,
      // Required by undici to send a streaming request body: we are not
      // reading the response before finishing the request.
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })

    if (!res.ok) {
      // Consume the body so the socket can be reused, but log only the status
      // - Immich's error text can carry user-controlled values.
      await res.text().catch(() => '')
      log.warn(`Immich rejected an upload with status ${res.status}`)
      return { ok: false, reason: 'rejected' }
    }
    const body = await res.json() as { id?: string, status?: string }
    if (!body?.id) return { ok: false, reason: 'error' }
    return { ok: true, id: body.id, status: body.status || 'created' }
  } catch (e) {
    if (e instanceof UploadTooLarge) return { ok: false, reason: 'too-large' }
    if (e instanceof Error && (e.name === 'AbortError' || (e as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE')) {
      return { ok: false, reason: 'aborted' }
    }
    log.warn(`Upload to Immich failed: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, reason: 'error' }
  }
}
