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
  | { ok: false, reason: 'too-large' | 'aborted' | 'rejected' | 'error' | 'empty' | 'not-media' }

/**
 * Why a flag and not `instanceof` on the caught error: fetch wraps anything
 * thrown by a streaming request body in `TypeError('fetch failed', { cause })`,
 * and undici is free to re-wrap again. Classifying the failure at the point it
 * happens is the only way to tell "visitor sent too much" apart from "visitor
 * hung up" once the error has been through that machinery.
 */
interface UploadState {
  overflowed: boolean
  empty: boolean
  notMedia: boolean
}

/** Multipart field values we generate; never anything visitor-controlled. */
const DEVICE_ID = 'immich-public-proxy'

/**
 * Strip anything that could break out of the `filename="..."` parameter or
 * smuggle extra headers into the part. Quotes, backslashes and CR/LF are the
 * injection vectors; path separators are dropped so a name like
 * `../../etc/passwd` cannot travel upstream as a path.
 */
export function sanitiseFilename (raw: string): string {
  // The client percent-encodes the name so it survives as a header value;
  // decode once before sanitising, or `holiday photo.jpg` reaches Immich as
  // `holiday%20photo.jpg`. A malformed sequence throws - keep the raw value
  // rather than dropping the upload over a filename.
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch (e) { /* not valid percent-encoding; use as-is */ }
  const base = decoded.split(/[\\/]/).pop() || ''
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
  return truncatePreservingExtension(cleaned, 255) || 'upload'
}

/**
 * Trim to `max` characters without eating the extension - Immich derives the
 * stored file's type from it, so `very-long-name.jpg` must not become
 * `very-long-nam`.
 */
function truncatePreservingExtension (name: string, max: number): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  // Only treat a trailing dot-segment as an extension if it is plausibly one.
  if (dot > 0 && name.length - dot <= 12) {
    const ext = name.slice(dot)
    return name.slice(0, Math.max(1, max - ext.length)) + ext
  }
  return name.slice(0, max)
}

/*
 * Magic-byte check.
 *
 * Immich decides an asset's type from the filename extension and does not
 * look at the bytes on the way in, so `PK\x03\x04...` sent as `payload.png`
 * is accepted and stored - verified against a live instance. On an
 * authenticated client that is merely surprising; on an anonymous public
 * upload route it means anyone holding the link can park arbitrary content in
 * the owner's library, and only find out when thumbnail generation fails.
 *
 * So we check the declared type against the actual bytes. The rule is
 * deliberately one-sided: if we know the signature for the declared type and
 * it does not match, refuse. If we do not know it (something exotic), let it
 * through and leave the decision to Immich, rather than rejecting formats
 * this table has not heard of.
 */
const SNIFF_BYTES = 16

function matchesDeclaredType (contentType: string, head: Buffer): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase()
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b)
  const at = (offset: number, ascii: string) => head.subarray(offset, offset + ascii.length).toString('latin1') === ascii

  switch (type) {
    case 'image/png': return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'image/jpeg': return starts(0xff, 0xd8, 0xff)
    case 'image/gif': return at(0, 'GIF8')
    case 'image/webp': return at(0, 'RIFF') && at(8, 'WEBP')
    case 'image/tiff': return starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)
    case 'image/bmp': return at(0, 'BM')
    // ISO base media: HEIC/HEIF/AVIF and the MP4/MOV family all carry `ftyp`.
    case 'image/heic':
    case 'image/heif':
    case 'image/avif':
    case 'video/mp4':
    case 'video/quicktime': return at(4, 'ftyp')
    case 'video/x-matroska':
    case 'video/webm': return starts(0x1a, 0x45, 0xdf, 0xa3)
    // Unknown to us - Immich still gates on the extension.
    default: return true
  }
}

/**
 * Immich derives an asset's type from the filename extension, and answers
 * `400 Unsupported file type upload` when there is none. A sanitised name can
 * legitimately end up extensionless - the client omitted the header, or the
 * original name simply had no dot - so give it one from the declared content
 * type rather than letting the upload die at the far end.
 *
 * The map covers the types worth naming explicitly; anything else falls back
 * to the mime subtype, which is right far more often than it is wrong
 * (`image/webp` -> `.webp`).
 */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm'
}

export function ensureExtension (name: string, contentType: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && name.length - dot <= 12) return name
  const type = contentType.split(';')[0].trim().toLowerCase()
  const mapped = EXTENSION_BY_TYPE[type]
  if (mapped) return name + mapped
  const subtype = type.split('/')[1]
  if (subtype && /^[a-z0-9]{1,10}$/.test(subtype)) return name + '.' + subtype
  return name
}

/**
 * Yield the multipart body: generated text fields, then the visitor's bytes,
 * then the closing boundary. Counting happens here so an over-size upload is
 * cut off mid-stream rather than after we have already relayed it all.
 */
async function * multipartBody (req: UploadRequest, boundary: string, st: UploadState): AsyncGenerator<Buffer> {
  const filename = ensureExtension(sanitiseFilename(req.filename), req.contentType)
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
  // Hold back just enough of the leading bytes to identify the format. This
  // is the only buffering in the path, and it is 16 bytes.
  let head: Buffer | null = Buffer.alloc(0)

  for await (const chunk of req.body) {
    bytes += chunk.length
    if (bytes > req.maxBytes) {
      // Mark before throwing: fetch will wrap this error beyond recognition.
      // Throwing aborts the request body mid-flight, so Immich sees a broken
      // upload and discards it. Content-Length is not trustworthy for this
      // check - a chunked request simply omits it.
      st.overflowed = true
      throw new UploadTooLarge()
    }
    if (head) {
      head = Buffer.concat([head, chunk])
      if (head.length < SNIFF_BYTES) continue
      if (!matchesDeclaredType(req.contentType, head)) {
        st.notMedia = true
        throw new UploadNotMedia()
      }
      yield head
      head = null
      continue
    }
    yield chunk
  }

  // Short file: never reached the sniff threshold, so decide on what we have.
  if (head) {
    if (head.length === 0) {
      st.empty = true
      throw new UploadEmpty()
    }
    if (!matchesDeclaredType(req.contentType, head)) {
      st.notMedia = true
      throw new UploadNotMedia()
    }
    yield head
  }

  yield Buffer.from(`\r\n--${boundary}--\r\n`)
}

class UploadTooLarge extends Error {
  constructor () {
    super('Upload exceeded the configured size limit')
    this.name = 'UploadTooLarge'
  }
}

class UploadEmpty extends Error {
  constructor () {
    super('Upload had no body')
    this.name = 'UploadEmpty'
  }
}

class UploadNotMedia extends Error {
  constructor () {
    super('Upload bytes do not match the declared content type')
    this.name = 'UploadNotMedia'
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

  const st: UploadState = { overflowed: false, empty: false, notMedia: false }
  const stream = Readable.from(multipartBody(req, boundary, st))
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      signal: req.signal,
      // Required by undici before it will accept a streaming request body.
      // Note this is NOT a promise that the response arrives only after the
      // request finishes - undici may hand us a response while we are still
      // sending, which is why the `finally` below tears the producer down
      // rather than assuming it ran to completion.
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })

    if (!res.ok) {
      // Consume the body so the socket can be reused, but log only the status
      // - Immich's error text can carry user-controlled values.
      await res.text().catch(() => '')
      if (st.overflowed) return { ok: false, reason: 'too-large' }
      if (st.empty) return { ok: false, reason: 'empty' }
      if (st.notMedia) return { ok: false, reason: 'not-media' }
      log.warn(`Immich rejected an upload with status ${res.status}`)
      return { ok: false, reason: 'rejected' }
    }
    const body = await res.json() as { id?: string, status?: string }
    if (!body?.id) return { ok: false, reason: 'error' }
    return { ok: true, id: body.id, status: body.status || 'created' }
  } catch (e) {
    // Classified at the source, because fetch wraps body errors in an opaque
    // TypeError - `instanceof UploadTooLarge` would not survive the trip.
    if (st.overflowed || e instanceof UploadTooLarge) return { ok: false, reason: 'too-large' }
    if (st.empty || e instanceof UploadEmpty) return { ok: false, reason: 'empty' }
    if (st.notMedia || e instanceof UploadNotMedia) return { ok: false, reason: 'not-media' }
    if (isAbort(e)) return { ok: false, reason: 'aborted' }
    log.warn(`Upload to Immich failed: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, reason: 'error' }
  } finally {
    // If Immich answered early (or we bailed out), the generator may still be
    // pulling from the visitor's socket. Destroy it so the slot and the
    // upstream connection are released rather than lingering.
    if (!stream.destroyed) stream.destroy()
  }
}

/** Visitor went away, or our own abort signal fired first. */
function isAbort (e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as NodeJS.ErrnoException).code
  const cause = (e as { cause?: unknown }).cause
  if (e.name === 'AbortError' || code === 'ERR_STREAM_PREMATURE_CLOSE') return true
  // fetch wraps the underlying cause; look one level down too.
  return cause instanceof Error &&
    (cause.name === 'AbortError' || (cause as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE')
}
