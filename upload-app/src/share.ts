import { cachedPromise, fetchSharedLink, KeyType, SharedLinkResult, TtlLruCache } from '@ipp/core'

/*
  Share lookups, cached for 60 s per (key type, key, password). The cache
  bounds how stale the `allowUpload` check can be when an owner turns the
  toggle off; Immich enforces the toggle on every upload regardless.
*/
const shareCache = new TtlLruCache<Promise<SharedLinkResult>>({ ttlMs: 60_000, max: 100 })

/** Look up a share through `@ipp/core`, sharing one Immich call across concurrent requests. */
export function getShare (key: string, keyType: KeyType, password?: string): Promise<SharedLinkResult> {
  return cachedPromise(shareCache, `${keyType}:${key}:${password || ''}`, () => fetchSharedLink(key, keyType, password, { logKeys: false }), result => result.valid)
}

/**
 * Drop a share's cached lookup after an upload changed it, so the next
 * request sees the new asset count (the `maxAssets` cap) at once.
 *
 * A share reached by its slug is cached under the slug, and the same share
 * reached by its key under the key, so `receive.ts` drops both identities:
 * dropping only the one the upload came in by would leave the other stale.
 */
export function invalidateShare (key: string, keyType: KeyType, password?: string): void {
  shareCache.delete(`${keyType}:${key}:${password || ''}`)
}
