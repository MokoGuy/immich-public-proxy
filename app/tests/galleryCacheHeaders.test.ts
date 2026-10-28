import { describe, it, expect } from 'vitest'
import { KeyType, SharedLink } from '@ipp/core'
import { setGalleryCacheHeaders } from '../src/gallery/builder'

function fakeRes (initial: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...initial }
  const res = {
    headers,
    set (name: string, value: string) { headers[name.toLowerCase()] = value; return res },
    header (name: string, value: string) { headers[name.toLowerCase()] = value; return res }
  }
  return res
}

const share = (overrides: Partial<SharedLink> = {}): SharedLink => ({
  key: 'k', keyType: KeyType.key, type: 'ALBUM', assets: [], expiresAt: null, ...overrides
})

describe('gallery cache headers', () => {
  it('lets a read-only gallery be cached for gallery.cacheTime', () => {
    const res = fakeRes()
    // @ts-expect-error minimal fake
    setGalleryCacheHeaders(res, share(), false)
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('never lets a browser or shared cache hold a gallery that takes uploads', () => {
    const res = fakeRes()
    // @ts-expect-error minimal fake
    setGalleryCacheHeaders(res, share(), true)
    expect(res.headers['cache-control']).toMatch(/^no-store/)
  })

  it('never downgrades the no-store of a password-protected gallery', () => {
    const res = fakeRes({ 'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate' })
    // @ts-expect-error minimal fake
    setGalleryCacheHeaders(res, share({ password: 'pw' }), false)
    expect(res.headers['cache-control']).toMatch(/^no-store/)
    // @ts-expect-error minimal fake
    setGalleryCacheHeaders(res, share({ password: 'pw' }), true)
    expect(res.headers['cache-control']).toMatch(/^no-store/)
  })
})
