import { describe, it, expect, afterEach } from 'vitest'
import { KeyType } from '@ipp/core'
import { assertPermit, authoriseUpload, UploadPermit } from '../src/gate'
import { resetConfig, setConfig, share } from './helpers'

afterEach(resetConfig)

describe('authoriseUpload', () => {
  it('issues a permit only when the share\'s Immich toggle is on', () => {
    expect(authoriseUpload(share(), 'k', KeyType.key)).not.toBeNull()
    expect(authoriseUpload(share({ allowUpload: false }), 'k', KeyType.key)).toBeNull()
    expect(authoriseUpload(share({ allowUpload: undefined }), 'k', KeyType.key)).toBeNull()
  })

  it('refuses slug links when the operator has turned them off', () => {
    setConfig({ ipp: { allowSlugLinks: false } })
    expect(authoriseUpload(share(), 'my-slug', KeyType.slug)).toBeNull()
    expect(authoriseUpload(share(), 'k', KeyType.key)).not.toBeNull()
  })
})

describe('the per-link upload policy', () => {
  it('refuses a link the operator policy rejects, even with the owner\'s toggle on', () => {
    expect(authoriseUpload(share({ expiresAt: null }), 'k', KeyType.key)).toBeNull()
    expect(authoriseUpload(share({ album: { id: 'a', assetCount: 500 } }), 'k', KeyType.key)).toBeNull()
    expect(authoriseUpload(share({ type: 'INDIVIDUAL' }), 'k', KeyType.key)).toBeNull()
    expect(authoriseUpload(share(), 'my-slug', KeyType.slug)).toBeNull()
  })

  it('follows the operator when a requirement is turned off', () => {
    setConfig({ ipp: { upload: { requireRandomKey: false } } })
    expect(authoriseUpload(share(), 'my-slug', KeyType.slug)).not.toBeNull()
  })

  it('re-checks the policy at the point of use', () => {
    const link = share()
    const permit = authoriseUpload(link, 'k', KeyType.key)!
    link.album = { id: 'a', assetCount: 10_000 }
    expect(() => assertPermit(permit)).toThrow('does not allow uploads')
  })
})

describe('assertPermit', () => {
  it('passes a permit from authoriseUpload', () => {
    expect(() => assertPermit(authoriseUpload(share(), 'k', KeyType.key)!)).not.toThrow()
  })

  it('throws for a permit built by hand', () => {
    const forged = { link: share(), key: 'k', keyType: KeyType.key } as unknown as UploadPermit
    expect(() => assertPermit(forged)).toThrow('without a permit')
  })

  it('throws when the share stopped accepting uploads after the permit was issued', () => {
    const link = share()
    const permit = authoriseUpload(link, 'k', KeyType.key)!
    link.allowUpload = false
    expect(() => assertPermit(permit)).toThrow('does not allow uploads')
  })
})
