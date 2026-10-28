import { describe, it, expect, afterEach } from 'vitest'
import dayjs from 'dayjs'
import { loadConfig } from '../src/config/loader'
import { AlbumType, KeyType, SharedLink } from '../src/types'
import { albumAssetCount, isPasswordProtected, uploadRefusal, uploadRefusalMessage } from '../src/upload/gate'

function setConfig (config: Record<string, unknown>) {
  process.env.CONFIG = JSON.stringify(config)
  loadConfig()
}

afterEach(() => {
  delete process.env.CONFIG
  loadConfig()
})

const now = dayjs('2026-06-01T12:00:00Z')

function link (overrides: Partial<SharedLink> = {}): SharedLink {
  return {
    key: 'k',
    keyType: KeyType.key,
    type: AlbumType.album,
    assets: [],
    allowUpload: true,
    expiresAt: now.add(7, 'day').toISOString(),
    album: { id: 'a', assetCount: 3 },
    ...overrides
  }
}

describe('uploadRefusal with the default policy', () => {
  it('accepts an album link with a random key and an expiry inside 30 days', () => {
    expect(uploadRefusal(link(), KeyType.key, now)).toBeNull()
  })

  it('refuses when the owner has not allowed uploads', () => {
    expect(uploadRefusal(link({ allowUpload: false }), KeyType.key, now)).toBe('not-allowed')
    expect(uploadRefusal(link({ allowUpload: undefined }), KeyType.key, now)).toBe('not-allowed')
  })

  it('refuses a share of selected photos', () => {
    expect(uploadRefusal(link({ type: AlbumType.individual }), KeyType.key, now)).toBe('not-album')
  })

  it('refuses a slug link, and a slug link when slug links are off', () => {
    expect(uploadRefusal(link(), KeyType.slug, now)).toBe('slug')
    setConfig({ ipp: { allowSlugLinks: false } })
    expect(uploadRefusal(link(), KeyType.slug, now)).toBe('slug-disabled')
  })

  it('refuses a link with no expiry, an expired one and one beyond the horizon', () => {
    expect(uploadRefusal(link({ expiresAt: null }), KeyType.key, now)).toBe('no-expiry')
    expect(uploadRefusal(link({ expiresAt: now.subtract(1, 'minute').toISOString() }), KeyType.key, now)).toBe('expired')
    expect(uploadRefusal(link({ expiresAt: 'not a date' }), KeyType.key, now)).toBe('expired')
    expect(uploadRefusal(link({ expiresAt: now.add(31, 'day').toISOString() }), KeyType.key, now)).toBe('expiry-too-far')
    expect(uploadRefusal(link({ expiresAt: now.add(30, 'day').toISOString() }), KeyType.key, now)).toBeNull()
  })

  it('refuses once the album holds maxAssets, counting whichever source is larger', () => {
    expect(uploadRefusal(link({ album: { id: 'a', assetCount: 499 } }), KeyType.key, now)).toBeNull()
    expect(uploadRefusal(link({ album: { id: 'a', assetCount: 500 } }), KeyType.key, now)).toBe('album-full')
    const assets = new Array(500).fill({})
    expect(uploadRefusal(link({ album: { id: 'a' }, assets }), KeyType.key, now)).toBe('album-full')
  })

  it('does not require a password', () => {
    expect(uploadRefusal(link(), KeyType.key, now)).toBeNull()
  })
})

describe('uploadRefusal with the policy relaxed or tightened', () => {
  it('lets each requirement be turned off', () => {
    setConfig({ ipp: { upload: { requireRandomKey: false, requireExpiry: false, albumOnly: false, maxAssets: 0 } } })
    expect(uploadRefusal(link(), KeyType.slug, now)).toBeNull()
    expect(uploadRefusal(link({ expiresAt: null }), KeyType.key, now)).toBeNull()
    expect(uploadRefusal(link({ type: AlbumType.individual }), KeyType.key, now)).toBeNull()
    expect(uploadRefusal(link({ album: { id: 'a', assetCount: 100_000 } }), KeyType.key, now)).toBeNull()
  })

  it('takes another horizon, and 0 as no horizon', () => {
    setConfig({ ipp: { upload: { maxExpiryDays: 3 } } })
    expect(uploadRefusal(link(), KeyType.key, now)).toBe('expiry-too-far')
    setConfig({ ipp: { upload: { maxExpiryDays: 0 } } })
    expect(uploadRefusal(link({ expiresAt: now.add(3650, 'day').toISOString() }), KeyType.key, now)).toBeNull()
  })

  it('requires a password from Immich, not from the visitor', () => {
    setConfig({ ipp: { upload: { requirePassword: true } } })
    expect(uploadRefusal(link(), KeyType.key, now)).toBe('no-password')
    // A visitor can carry a session password to a link that has none
    expect(uploadRefusal(link({ password: 'typed-by-visitor' }), KeyType.key, now)).toBe('no-password')
    expect(uploadRefusal(link({ passwordProtected: true, password: 'pw' }), KeyType.key, now)).toBeNull()
  })
})

describe('helpers', () => {
  it('counts the album from Immich or from the enumerated assets', () => {
    expect(albumAssetCount(link({ album: { id: 'a', assetCount: 7 } }))).toBe(7)
    expect(albumAssetCount(link({ album: undefined, assets: new Array(4).fill({}) }))).toBe(4)
  })

  it('reads password protection only from Immich', () => {
    expect(isPasswordProtected(link({ password: 'x' }))).toBe(false)
    expect(isPasswordProtected(link({ passwordProtected: true }))).toBe(true)
  })

  it('has a sentence for every refusal', () => {
    for (const r of ['not-allowed', 'slug-disabled', 'not-album', 'slug', 'no-password', 'no-expiry', 'expired', 'expiry-too-far', 'album-full'] as const) {
      expect(uploadRefusalMessage(r)).toMatch(/\S/)
    }
  })
})
