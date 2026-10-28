import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { KeyType } from '@ipp/core'
import { checkDuplicate, isSha1Base64 } from '../src/duplicate'

const CHECKSUM = 'qUqP5cyxm6YcTAhz05Hph5gvu9M='

/** An Immich that answers the probe, and the follow-up read, as told. */
function stubImmich (opts: { probe: number | 'down', hit?: string, readable?: boolean }) {
  const calls: Array<{ url: string, method: string, checksum?: string }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers || {}) as Record<string, string>
    calls.push({ url, method: init.method || 'GET', checksum: headers['x-immich-checksum'] })
    if (opts.probe === 'down') throw new TypeError('fetch failed')
    if (init.method === 'POST') {
      const body = opts.hit ? { id: opts.hit, status: 'duplicate' } : { message: 'Unsupported file type' }
      return new Response(JSON.stringify(body), { status: opts.hit ? 200 : opts.probe, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: opts.readable ? 200 : 400 })
  })
  return calls
}

beforeEach(() => { process.env.IMMICH_URL = 'http://immich.test' })
afterEach(() => { vi.unstubAllGlobals() })

const ask = () => checkDuplicate({ key: 'k', keyType: KeyType.key, checksum: CHECKSUM })

describe('checkDuplicate', () => {
  it('relays the checksum to Immich and says yes for an asset the share shows', async () => {
    const calls = stubImmich({ probe: 400, hit: 'asset-1', readable: true })
    expect(await ask()).toEqual({ available: true, duplicate: true })
    expect(calls[0]).toMatchObject({ method: 'POST', checksum: CHECKSUM })
    expect(calls[0].url).toContain('/assets?key=k')
    expect(calls[1].url).toContain('/assets/asset-1?key=k')
  })

  it('says no for an asset the owner holds outside the share', async () => {
    stubImmich({ probe: 400, hit: 'asset-elsewhere', readable: false })
    expect(await ask()).toEqual({ available: true, duplicate: false })
  })

  it('reads Immich refusing the empty probe as a miss, not as a failure', async () => {
    stubImmich({ probe: 400 })
    expect(await ask()).toEqual({ available: true, duplicate: false })
  })

  it('reports a check that could not be made as unavailable', async () => {
    stubImmich({ probe: 'down' })
    expect(await ask()).toEqual({ available: false })
  })

  it('never returns the asset id', async () => {
    stubImmich({ probe: 400, hit: 'asset-1', readable: true })
    expect(JSON.stringify(await ask())).not.toContain('asset-1')
  })
})

describe('isSha1Base64', () => {
  it('accepts a base64 SHA-1 and nothing else', () => {
    expect(isSha1Base64(CHECKSUM)).toBe(true)
    for (const bad of ['', 'abc', CHECKSUM + 'x', CHECKSUM.replace('=', '!'), undefined, ['a']]) {
      expect(isSha1Base64(bad)).toBe(false)
    }
  })
})
