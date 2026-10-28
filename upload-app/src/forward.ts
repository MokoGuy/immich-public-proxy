import { Readable } from 'stream'
import crypto from 'crypto'
import { apiUrl, authHeaders, buildUrl, log, streamingRequestInit } from '@ipp/core'
import { UploadPermit, assertPermit } from './gate'
import { matchesDeclaredType, SNIFF_BYTES } from './sniff'
import { CaptureDate, captureDate, DateSource, noteParserFailure } from './capture-date'

/**
 * Everything forwarded about one file, already validated by `receive.ts`.
 * `filename` is sanitised and carries an extension; `mimeType` is the bare
 * type with no parameters.
 */
export interface IncomingUpload {
  filename: string
  mimeType: string
  fileCreatedAt: string
  fileModifiedAt: string
  /** Raw file bytes, streamed straight through and never buffered. */
  body: Readable
  /** The declared `Content-Length`; the upload aborts past it. */
  maxBytes: number
}

export type ForwardResult =
  | { ok: true, status: 'created' | 'duplicate', id: string, bytes: number, dateSource?: DateSource }
  | { ok: false, status: number, reason: string }

export const NOT_ACCEPTING_UPLOADS = 'This share does not accept uploads'
export const NOT_MEDIA = 'The file\'s content does not match its type'

/** Thrown by the body generator when an upload runs past `maxBytes`. */
class UploadTooLargeError extends Error {}

/** Thrown by the body generator when the leading bytes contradict the declared type. */
class UploadNotMediaError extends Error {}

/*
  What the body generator found, recorded where it happens. fetch wraps an
  error thrown by a streaming request body in `TypeError('fetch failed')`,
  and undici may wrap it again, so the outcome is classified from these flags
  rather than from the error that comes out of fetch.
*/
interface BodyState {
  bytes: number
  overflowed: boolean
  notMedia: boolean
  /** Where `fileCreatedAt` came from, once the preamble is written. */
  dateSource?: DateSource
}

/*
  How much of the file is held back before the multipart fields go out.
  `fileCreatedAt` is written before the bytes, so the capture date has to be
  known by then, and it lives in the EXIF block near the start of the file.
  128 KiB covers a JPEG APP1 segment and a HEIC meta box; it is held per
  upload in flight, which `maxConcurrent` bounds.
*/
const HEAD_BYTES = 128 * 1024

/**
 * Serialise one multipart/form-data body for Immich's `POST /assets`. The
 * field set is fixed, so it is written by hand. The async generator pulls a
 * chunk only when the socket to Immich is ready for it.
 *
 * Only the two timestamps and the file are sent, so fields Immich would
 * otherwise honour (`visibility`, `livePhotoVideoId`, `metadata`,
 * `sidecarData`) cannot be set by a visitor. The filename rides on the
 * part's own Content-Disposition, which is where Immich reads it from.
 */
function multipartBody (boundary: string, upload: IncomingUpload, state: BodyState): Readable {
  const part = (headers: string) => Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`)

  /*
    The fields, once the head is in hand. Immich dates an asset from
    DateTimeOriginal or CreateDate when the file has one, and otherwise keeps
    `fileCreatedAt`, which the browser can only fill from `lastModified`: for
    a copy handed over by a phone's photo picker, the moment of the export.
    So the date is read from the file here, DateTime included, which Immich
    ignores but which beats the upload clock.
  */
  function * preamble (head: Buffer) {
    let when: CaptureDate
    try {
      when = captureDate(head, upload.mimeType, upload.fileCreatedAt)
    } catch {
      // The parser must never be able to fail an upload
      noteParserFailure()
      when = { iso: upload.fileCreatedAt, source: 'client' }
    }
    state.dateSource = when.source
    const fields: Record<string, string> = {
      fileCreatedAt: when.iso,
      fileModifiedAt: upload.fileModifiedAt
    }
    for (const [name, value] of Object.entries(fields)) {
      yield part(`Content-Disposition: form-data; name="${name}"`)
      yield Buffer.from(value + '\r\n')
    }
    yield part(
      `Content-Disposition: form-data; name="assetData"; filename="${upload.filename}"\r\n` +
      `Content-Type: ${upload.mimeType}`
    )
  }

  async function * generate () {
    // The leading bytes are held back until the type check has run, so a
    // file that is not what it claims never reaches Immich at all
    let head: Buffer | null = Buffer.alloc(0)
    let sniffed = false
    for await (const chunk of upload.body) {
      state.bytes += chunk.length
      if (state.bytes > upload.maxBytes) {
        state.overflowed = true
        throw new UploadTooLargeError()
      }
      if (head) {
        head = Buffer.concat([head, chunk])
        // The type check runs as soon as it can, so a file that is not
        // media dies before 128 KiB of it is held
        if (!sniffed && head.length >= SNIFF_BYTES) {
          if (!matchesDeclaredType(upload.mimeType, head)) {
            state.notMedia = true
            throw new UploadNotMediaError()
          }
          sniffed = true
        }
        if (head.length < HEAD_BYTES) continue
        yield * preamble(head)
        yield head
        head = null
        continue
      }
      yield chunk
    }
    if (head) {
      // The whole file was shorter than the check needs
      if (!sniffed && !matchesDeclaredType(upload.mimeType, head)) {
        state.notMedia = true
        throw new UploadNotMediaError()
      }
      yield * preamble(head)
      yield head
    }
    yield Buffer.from(`\r\n--${boundary}--\r\n`)
  }

  return Readable.from(generate())
}

/**
 * Map Immich's answer to an upload onto the reply the visitor gets. 201 is a
 * new asset; 200 is a checksum match with an asset the owner already has,
 * which Immich still adds to the album or link. 400 is Immich refusing the
 * file itself. 401 and 403 mean the share no longer accepts uploads.
 */
export function replyForImmichStatus (status: number, body?: { id?: string, status?: string } | null): ForwardResult {
  if (status === 200 || status === 201) {
    return { ok: true, status: body?.status === 'duplicate' ? 'duplicate' : 'created', id: body?.id || '', bytes: 0 }
  }
  if (status === 400) return { ok: false, status: 400, reason: 'Immich would not accept this file' }
  if (status === 401 || status === 403) return { ok: false, status: 403, reason: NOT_ACCEPTING_UPLOADS }
  return { ok: false, status: 502, reason: 'Immich rejected the upload' }
}

/**
 * Send one upload to Immich as the share, and report what Immich made of it.
 * Authentication is the visitor's share key (plus the password token for a
 * password share); Immich files the asset into the album or the link itself.
 * Errors are returned, except a permit failure, which is a bug.
 */
export async function forwardUpload (permit: UploadPermit, upload: IncomingUpload, signal: AbortSignal): Promise<ForwardResult> {
  assertPermit(permit)

  const boundary = '----IPPUpload' + crypto.randomBytes(16).toString('hex')
  const state: BodyState = { bytes: 0, overflowed: false, notMedia: false }
  const url = buildUrl(apiUrl() + '/assets', { [permit.keyType]: permit.key })

  const multipart = multipartBody(boundary, upload, state)
  let res: globalThis.Response
  try {
    res = await fetch(url, streamingRequestInit({
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        ...(await authHeaders(permit.keyType, permit.key, permit.password))
      },
      signal
    }, multipart))
  } catch (e) {
    // The generator's throw surfaces here as the fetch rejecting, wrapped
    if (state.overflowed || causedBy(e, UploadTooLargeError)) return { ok: false, status: 413, reason: 'File is larger than declared' }
    if (state.notMedia || causedBy(e, UploadNotMediaError)) return { ok: false, status: 415, reason: NOT_MEDIA }
    if (signal.aborted) return { ok: false, status: 499, reason: 'Visitor cancelled the upload' }
    log.warn('Upload to Immich failed for ' + upload.filename + ': ' + errorText(e))
    return { ok: false, status: 502, reason: 'Could not reach Immich' }
  } finally {
    // Immich may answer before the body is through; stop pulling from the visitor
    if (!multipart.readableEnded) multipart.destroy()
  }

  const body = await res.json().catch(() => null) as { id?: string, status?: string, message?: string } | null
  // An early answer to a body the generator gave up on: the flag is the truth
  if (state.overflowed) return { ok: false, status: 413, reason: 'File is larger than declared' }
  if (state.notMedia) return { ok: false, status: 415, reason: NOT_MEDIA }
  const result = replyForImmichStatus(res.status, body)
  if (result.ok) return { ...result, bytes: state.bytes, dateSource: state.dateSource }
  log.warn('Immich refused upload ' + upload.filename + ' with status ' + res.status +
    (body?.message ? ': ' + body.message : ''))
  return result
}

/** Walk the `cause` chain: fetch wraps the body generator's error. */
function causedBy (e: unknown, type: new () => Error): boolean {
  let current: unknown = e
  while (current instanceof Error) {
    if (current instanceof type) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function errorText (e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
