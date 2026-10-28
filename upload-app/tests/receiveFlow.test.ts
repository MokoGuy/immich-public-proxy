import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Readable } from 'stream'
import { KeyType } from '@ipp/core'
import { createUploadReceiver } from '../src/receive'
import { flush, resetUploadReporting } from '../src/upload-log'
import { resetConfig, setConfig, share } from './helpers'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 9, 9, 9, 9])
const SECRET_NAME = 'jane-doe-private-IMG_0042.png'

function fakeRes () {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status (code: number) { res.statusCode = code; return res },
    json (body: unknown) { res.body = body; res.headersSent = true; return res },
    send (body?: unknown) { res.body = body; res.headersSent = true; return res },
    set () { return res },
    setHeader () { return res },
    once () { return res },
    destroy () {}
  }
  return res
}

/** A request whose body is `body`, sent the way the page sends one. */
function fakeReq (body: Buffer, query: Record<string, string> = {}) {
  const req = Readable.from([body]) as Readable & Record<string, unknown>
  req.params = { key: 'the-share-key' }
  req.headers = { 'content-length': String(body.length), 'content-type': 'image/png' }
  req.query = { filename: SECRET_NAME, uploader: 'Jane Doe', fileCreatedAt: '2026-01-01T00:00:00.000Z', ...query }
  req.ip = '203.0.113.9'
  return req
}

let output: string[] = []
beforeEach(() => {
  process.env.IMMICH_URL = 'http://immich.test'
  resetUploadReporting()
  output = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(' ')) })
  }
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    await new Response(init.body as BodyInit).arrayBuffer()
    return new Response(JSON.stringify({ id: 'asset-1', status: 'created' }), { status: 201, headers: { 'Content-Type': 'application/json' } })
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetUploadReporting()
  resetConfig()
})

describe('receiving an upload', () => {
  it('answers with the outcome and the date source, and logs nothing about the visitor', async () => {
    const res = fakeRes()
    // @ts-expect-error minimal fakes
    await createUploadReceiver()(fakeReq(PNG), res, share(), KeyType.key, new AbortController().signal)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ status: 'created', dateSource: 'client' })

    flush(2)
    const log = output.join('\n')
    expect(log).toMatch(/Guest upload \| upload: created=1 no-capture-date=1/)
    for (const secret of [SECRET_NAME, 'jane', 'the-share-key', '203.0.113.9', share().id!]) {
      expect(log).not.toContain(secret)
    }
  })

  it('counts a refusal without naming the file', async () => {
    const res = fakeRes()
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString()
    // @ts-expect-error minimal fakes
    await createUploadReceiver()(fakeReq(PNG, { fileCreatedAt: future }), res, share(), KeyType.key, new AbortController().signal)
    expect(res.statusCode).toBe(400)
    flush(2)
    const log = output.join('\n')
    expect(log).toContain('bad-date=1')
    expect(log).not.toContain(SECRET_NAME)
  })
})

describe('the share cache after an upload', () => {
  it('drops both the submitted and the canonical identity of the share', async () => {
    // A slug upload, so the two identities differ
    setConfig({ ipp: { upload: { requireRandomKey: false } } })
    const shareModule = await import('../src/share')
    const spy = vi.spyOn(shareModule, 'invalidateShare')
    const res = fakeRes()
    const req = fakeReq(PNG)
    ;(req.params as Record<string, string>).key = 'holiday-slug'
    req.password = 'pw'
    // @ts-expect-error minimal fakes
    await createUploadReceiver()(req, res, share({ key: 'canonical-key' }), KeyType.slug, new AbortController().signal)
    expect(res.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledWith('holiday-slug', KeyType.slug, 'pw')
    expect(spy).toHaveBeenCalledWith('canonical-key', KeyType.key, 'pw')
  })
})
