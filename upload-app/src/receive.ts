import { pipeline } from 'stream'
import { Request, Response } from 'express-serve-static-core'
import dayjs from 'dayjs'
import { KeyType, respondToInvalidRequest, SharedLink, uploadRefusal, uploadRefusalMessage } from '@ipp/core'
import { askName, byteBudget, fieldSeparator, filenamePrefix, maxFileSize, rateLimit } from './config'
import { uploaderSlug, uploadFilename } from './filename'
import { forwardUpload } from './forward'
import { authoriseUpload } from './gate'
import { createIdleTimeoutStream, IdleTimeoutError } from './idleTimeoutStream'
import { createWindowBudget } from './limits'
import { buildNotification, sendNotification } from './notify'
import { formatSize, isUploadableName, isUploadableType } from './shared/upload'
import { recordUpload, UploadLabel } from './upload-log'

/*
  The visitor-facing half of the upload path: validate one request, then
  hand it to `forward.ts` with a permit from `gate.ts`.

  Each file is its own POST whose body is the raw bytes, with the name and
  timestamps in the query string. The app re-encodes for Immich anyway, so
  it runs no multipart parser on visitor input, and nothing is buffered or
  written to disk.
*/

/*
  A body that delivers less than this in any one-minute interval is dropped.
  The floor is far below any phone uplink (8 KB/s is 64 kbit/s), yet it means
  a connection that trickles bytes to keep its byte-budget reservation alive
  has to keep spending real bandwidth to do so.
*/
const BODY_IDLE_MS = 60_000
const BODY_MIN_BYTES_PER_INTERVAL = 8 * 1024 * BODY_IDLE_MS / 1000

/**
 * Answer an upload the server will not take, in the shape the page reads.
 * The connection closes after it (see `index.ts`), so a body still in flight
 * stops costing its full bandwidth.
 */
function refuse (res: Response, status: number, reason: string, label: UploadLabel): void {
  recordUpload(label)
  res.status(status).json({ error: reason })
}

/** The declared `Content-Length`, or undefined when absent or malformed. */
export function declaredLength (header: string | undefined): number | undefined {
  return header && /^\d+$/.test(header) ? Number(header) : undefined
}

/**
 * Parse a visitor-supplied timestamp, falling back to now. Only a starting
 * point: Immich replaces it from EXIF when the file carries a better date.
 */
export function uploadTimestamp (raw: unknown): string {
  const parsed = typeof raw === 'string' && raw ? dayjs(raw) : undefined
  return (parsed?.isValid() ? parsed : dayjs()).toISOString()
}

/**
 * Whether a visitor-supplied timestamp lies more than a day in the future: a
 * broken clock, which must not file a holiday photo under the year 3000.
 */
export function isFutureTimestamp (raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  const parsed = dayjs(raw)
  return parsed.isValid() && parsed.isAfter(dayjs().add(1, 'day'))
}

/**
 * Build the handler for `POST <share>/upload`, with its rate limit and byte
 * budget read from config. Called once, after the config has loaded.
 *
 * Once the share has passed the gate, failures a visitor can act on answer
 * with a status and a short JSON reason rather than the 404 policy.
 */
export function createUploadReceiver () {
  // Keyed on address and share; behind a reverse proxy every visitor has the proxy's address
  const rate = createWindowBudget({ limit: rateLimit(), windowMs: 60_000 })
  const budget = createWindowBudget({ limit: byteBudget(), windowMs: 60 * 60_000 })
  const maxBytes = maxFileSize()
  const prefix = filenamePrefix()
  const withName = askName()
  const separator = fieldSeparator()

  return async function receiveUpload (req: Request, res: Response, link: SharedLink, keyType: KeyType, signal: AbortSignal): Promise<void> {
    const key = req.params.key
    const permit = authoriseUpload(link, key, keyType, req.password)
    if (!permit) {
      const refusal = uploadRefusal(link, keyType)
      // A share whose owner said no, or a slug that is not a credential, stays
      // behind the 404 policy. Past that the visitor demonstrably holds a
      // working link, and "the album is full" tells them nothing they could
      // not see in the gallery.
      recordUpload(refusal || 'not-allowed')
      if (!refusal || refusal === 'not-allowed' || refusal === 'slug-disabled') {
        respondToInvalidRequest(res, 404, 'Share does not accept uploads')
        return
      }
      res.status(403).json({ error: uploadRefusalMessage(refusal), reason: refusal })
      return
    }
    const shareId = link.id || key

    const length = declaredLength(req.headers['content-length'])
    if (length === undefined) {
      refuse(res, 411, 'The upload has no Content-Length', 'no-length')
      return
    }
    if (length === 0) {
      refuse(res, 400, 'The file is empty', 'empty')
      return
    }
    if (length > maxBytes) {
      refuse(res, 413, 'Larger than the ' + formatSize(maxBytes) + ' limit', 'too-large')
      return
    }

    // The name is the visitor's claim, kept only as part of the filename
    const uploader = withName ? uploaderSlug(req.query.uploader) : ''
    const filename = uploadFilename(req.query.filename, prefix, uploader, separator)
    if (!filename) {
      refuse(res, 400, 'Missing or unusable filename', 'bad-filename')
      return
    }

    const mimeType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (!isUploadableType(mimeType) || !isUploadableName(filename)) {
      refuse(res, 415, 'Only photos and videos can be sent', 'not-media')
      return
    }

    if (isFutureTimestamp(req.query.fileCreatedAt) || isFutureTimestamp(req.query.fileModifiedAt)) {
      refuse(res, 400, 'The file\'s date is in the future. Check the device\'s clock.', 'bad-date')
      return
    }

    // Charged only once the request is one the service would take, so a
    // stream of malformed requests cannot use up everyone's allowance
    const rated = rate(req.ip + ':' + shareId)
    if (!rated.ok) {
      res.set('Retry-After', String(rated.retryAfterSeconds))
      refuse(res, 429, 'Too many uploads. Wait a moment and try again.', 'rate-limited')
      return
    }

    // Reserved before streaming, so parallel uploads cannot overshoot the budget together
    const reserved = budget(shareId, length)
    if (!reserved.ok) {
      res.set('Retry-After', String(reserved.retryAfterSeconds))
      refuse(res, 413, 'This share has received its limit for the hour. Try again later.', 'budget-exceeded')
      return
    }

    // A stall is read from the stream once the upload is over; the callback
    // only keeps the pipeline from reporting an unhandled error
    const body = pipeline(req, createIdleTimeoutStream(BODY_IDLE_MS, BODY_MIN_BYTES_PER_INTERVAL), () => {})
    const result = await forwardUpload(permit, {
      filename,
      mimeType,
      fileCreatedAt: uploadTimestamp(req.query.fileCreatedAt),
      fileModifiedAt: uploadTimestamp(req.query.fileModifiedAt),
      body,
      maxBytes: length
    }, signal)

    if (!result.ok) {
      reserved.release()
      const stalled = body.errored instanceof IdleTimeoutError
      // The visitor hung up, or a bound ended the request; there is nobody left to answer
      if (result.status === 499) {
        recordUpload(result.label)
        return
      }
      refuse(res, stalled ? 502 : result.status, stalled ? 'The upload stalled. Try again.' : result.reason, stalled ? 'body-stalled' : result.label)
      return
    }

    // Counted, never logged one by one: no filename, name or share reaches the log
    recordUpload(result.status)
    if (result.dateSource === 'client') recordUpload('no-capture-date')
    // `client`: the file carried no date of its own, so the album shows it as
    // taken when it was sent; the page tells the visitor while they are there
    res.json({ status: result.status, dateSource: result.dateSource })

    // After the reply, so a slow webhook never holds up the visitor
    sendNotification(buildNotification(
      link,
      { name: filename, size: result.bytes, type: mimeType },
      { id: result.id, status: result.status },
      uploader
    ))
  }
}
