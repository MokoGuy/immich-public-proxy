import { describe, it, expect, afterEach } from 'vitest'
import { KeyType } from '@ipp/core'
import { createUploadReceiver } from '../src/receive'
import { resetConfig, share } from './helpers'

afterEach(resetConfig)

/** The least of a Response that the refusal path touches. */
function fakeRes () {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status (code: number) { res.statusCode = code; return res },
    json (body: unknown) { res.body = body; return res },
    send (body?: unknown) { res.body = body; return res },
    set (name: string, value: string) { res.headers[name.toLowerCase()] = value; return res },
    setHeader (name: string, value: string) { res.headers[name.toLowerCase()] = value; return res },
    destroy () {}
  }
  return res
}

const fakeReq = (key = 'k') => ({ params: { key }, headers: {}, query: {} })

describe('a refused upload', () => {
  it('names a policy refusal, so the page can say why and stop the queue', async () => {
    const receive = createUploadReceiver()
    const res = fakeRes()
    // @ts-expect-error minimal fakes
    await receive(fakeReq(), res, share({ album: { id: 'a', assetCount: 500 } }), KeyType.key, new AbortController().signal)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: expect.stringMatching(/full/), reason: 'album-full' })
  })

  it('keeps a share whose owner said no behind the 404 policy', async () => {
    const receive = createUploadReceiver()
    const res = fakeRes()
    // @ts-expect-error minimal fakes
    await receive(fakeReq(), res, share({ allowUpload: false }), KeyType.key, new AbortController().signal)
    expect(res.statusCode).toBe(404)
  })
})
