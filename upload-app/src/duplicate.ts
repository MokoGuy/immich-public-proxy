import crypto from 'crypto'
import { apiUrl, authHeaders, buildUrl, KeyType } from '@ipp/core'

/*
  Ask Immich whether the share's owner already holds a file, without sending
  it, so a visitor's phone does not spend minutes uploading a video the
  album already shows.

  Immich's upload route reads `x-immich-checksum` and answers `duplicate`
  before it reads the body, so a probe costs one round trip and no media
  bytes. The dedicated `POST /assets/bulk-upload-check` is not an option: it
  does not accept a share key.

  Immich looks the checksum up across the owner's whole library, so the
  answer is then confined to the share: a hit counts only if the share key
  can read that asset, which it can for exactly the album's own assets. Told
  anything wider, a link holder could test whether the owner has a given file
  anywhere, without holding its bytes or passing the upload checks.
*/

/** A miss and an unanswerable check are different things: "send it", and "send it, and something is wrong". */
export type CheckResult =
  | { available: true, duplicate: boolean }
  | { available: false }

export interface CheckRequest {
  key: string
  keyType: KeyType
  password?: string
  /** Base64 SHA-1 of the file, as Immich stores it. */
  checksum: string
  signal?: AbortSignal
}

/** Base64 of 20 bytes: 27 characters and one `=`. Anything else is not a SHA-1. */
export function isSha1Base64 (value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{27}=$/.test(value)
}

function probeBody (boundary: string): Buffer {
  const now = new Date().toISOString()
  const field = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  return Buffer.from(
    field('fileCreatedAt', now) + field('fileModifiedAt', now) +
    `--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="probe"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n' +
    `\r\n--${boundary}--\r\n`
  )
}

/** Whether the share can read this asset, which for an album share means the album holds it. */
async function inShare (req: CheckRequest, id: string, headers: Record<string, string>): Promise<boolean> {
  const res = await fetch(buildUrl(apiUrl() + '/assets/' + encodeURIComponent(id), { [req.keyType]: req.key }), { headers, signal: req.signal })
  await res.arrayBuffer().catch(() => undefined)
  return res.status === 200
}

export async function checkDuplicate (req: CheckRequest): Promise<CheckResult> {
  const boundary = '----IPPCheck' + crypto.randomBytes(16).toString('hex')
  try {
    const auth = await authHeaders(req.keyType, req.key, req.password)
    const res = await fetch(buildUrl(apiUrl() + '/assets', { [req.keyType]: req.key }), {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'x-immich-checksum': req.checksum
      },
      body: probeBody(boundary),
      signal: req.signal
    })
    /*
      Any HTTP answer means the check ran. On a miss the request falls through
      to the real upload path, which refuses the empty probe: a MISS, not a
      failure. Only no answer at all (refused, timed out) means the check could
      not be made.
    */
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined)
      return { available: true, duplicate: false }
    }
    const json = await res.json().catch(() => null) as { id?: string, status?: string } | null
    if (json?.status !== 'duplicate' || !json.id) return { available: true, duplicate: false }
    return { available: true, duplicate: await inShare(req, json.id, auth) }
  } catch {
    // A failed check is not a failed upload: the page sends the file anyway
    return { available: false }
  }
}
