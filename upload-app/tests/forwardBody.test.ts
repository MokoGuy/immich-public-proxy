import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Readable } from 'stream'
import { KeyType } from '@ipp/core'
import { forwardUpload, IncomingUpload, NOT_MEDIA } from '../src/forward'
import { authoriseUpload } from '../src/gate'
import { matchesDeclaredType } from '../src/sniff'
import { share } from './helpers'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4])
const ZIP = Buffer.from('PK\x03\x04 this is not an image at all', 'latin1')

/** A fetch stand-in that reads the whole request body, as undici would, and wraps a body error the same way. */
function stubImmich (status = 201) {
  const seen: { body?: Buffer } = {}
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
      seen.body = Buffer.concat(chunks)
    } catch (cause) {
      throw new TypeError('fetch failed', { cause })
    }
    return new Response(JSON.stringify({ id: 'asset-1', status: 'created' }), { status, headers: { 'Content-Type': 'application/json' } })
  })
  return seen
}

function upload (body: Buffer, mimeType: string, chunkSize = 3): IncomingUpload {
  const chunks: Buffer[] = []
  for (let i = 0; i < body.length; i += chunkSize) chunks.push(body.subarray(i, i + chunkSize))
  return {
    filename: 'ipp_upload_x.png',
    mimeType,
    fileCreatedAt: '2026-01-01T00:00:00.000Z',
    fileModifiedAt: '2026-01-01T00:00:00.000Z',
    body: Readable.from(chunks),
    maxBytes: body.length
  }
}

const permit = () => authoriseUpload(share(), 'k', KeyType.key)!

beforeEach(() => { process.env.IMMICH_URL = 'http://immich.test' })
afterEach(() => { vi.unstubAllGlobals() })

describe('matchesDeclaredType', () => {
  it('accepts a file whose signature matches its type', () => {
    expect(matchesDeclaredType('image/png', PNG)).toBe(true)
    expect(matchesDeclaredType('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
    expect(matchesDeclaredType('video/quicktime', Buffer.from('\0\0\0\x14ftypqt  ', 'latin1'))).toBe(true)
    expect(matchesDeclaredType('image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe(true)
  })

  it('refuses a known type whose signature diverges', () => {
    expect(matchesDeclaredType('image/png', ZIP)).toBe(false)
    expect(matchesDeclaredType('image/jpeg; charset=binary', PNG)).toBe(false)
    expect(matchesDeclaredType('video/mp4', PNG)).toBe(false)
  })

  it('lets an unknown type through for Immich to judge', () => {
    expect(matchesDeclaredType('image/x-canon-cr2', ZIP)).toBe(true)
    expect(matchesDeclaredType('video/mp2t', ZIP)).toBe(true)
  })
})

describe('forwardUpload', () => {
  it('relays a file that is what it claims, bytes intact', async () => {
    const seen = stubImmich()
    const result = await forwardUpload(permit(), upload(PNG, 'image/png'), new AbortController().signal)
    expect(result).toMatchObject({ ok: true, status: 'created', bytes: PNG.length })
    expect(seen.body!.includes(PNG)).toBe(true)
  })

  it('refuses a file whose bytes contradict its type, before any of it reaches Immich', async () => {
    const seen = stubImmich()
    const result = await forwardUpload(permit(), upload(ZIP, 'image/png'), new AbortController().signal)
    expect(result).toEqual({ ok: false, status: 415, reason: NOT_MEDIA })
    expect(seen.body).toBeUndefined()
  })

  it('checks a file shorter than the signature window too', async () => {
    stubImmich()
    const result = await forwardUpload(permit(), upload(Buffer.from('GIF'), 'image/gif'), new AbortController().signal)
    expect(result).toMatchObject({ ok: false, status: 415 })
  })

  it('classifies a body that outgrows its declared length, through fetch\'s wrapping', async () => {
    stubImmich()
    const file = upload(PNG, 'image/png')
    file.maxBytes = 10
    const result = await forwardUpload(permit(), file, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, status: 413 })
  })
})
