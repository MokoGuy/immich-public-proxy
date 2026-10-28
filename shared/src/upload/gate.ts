import dayjs, { Dayjs } from 'dayjs'
import { AlbumType, KeyType, SharedLink } from '../types'
import { getConfigOption, getNumericConfigOption } from '../config/access'
import { slugLinksDisabled } from '../immich/share'

/*
  The per-link upload policy, shared by both apps: the upload service decides
  with it, and IPP shows the "Add photos" button only when it would pass, so
  the gallery never offers a door the upload service then shuts.

  Every condition must hold. Each closes a different way an upload link goes
  wrong once it is out of the owner's hands: a share key is a capability, not
  an identity. It travels in URLs, browser history, group chats and
  screenshots, and anyone holding it can write.

  The reasons are a closed vocabulary, so they can go into a log or a JSON
  answer without carrying anything the visitor sent.
*/

export type UploadRefusal =
  /** The owner did not turn on "Allow public user to upload". */
  | 'not-allowed'
  /** A slug link while the operator has turned slug links off. */
  | 'slug-disabled'
  /** A share of selected photos, not an album. */
  | 'not-album'
  /** A slug link: readable, so guessable, and refused for writes by policy. */
  | 'slug'
  /** The operator requires password-protected links. */
  | 'no-password'
  /** The link never expires. */
  | 'no-expiry'
  /** The link has expired. */
  | 'expired'
  /** The link expires further away than the configured horizon. */
  | 'expiry-too-far'
  /** The album holds `maxAssets` or more. */
  | 'album-full'

/**
 * How many assets the share's album holds. Immich reports `album.assetCount`
 * on `/shared-links/me`; IPP also enumerates the album, so the larger of the
 * two is used and neither side can undercount.
 */
export function albumAssetCount (link: SharedLink): number {
  const reported = typeof link.album?.assetCount === 'number' ? link.album.assetCount : 0
  return Math.max(reported, Array.isArray(link.assets) ? link.assets.length : 0)
}

/**
 * Whether Immich protects this link with a password. Read from Immich's own
 * answer (see `fetchSharedLink`); the visitor's session password is not
 * evidence, since a visitor can send one to a link that has none.
 */
export function isPasswordProtected (link: SharedLink): boolean {
  return link.passwordProtected === true
}

/**
 * Why an upload into this share would be refused, or null if it would not.
 * `keyType` is how the visitor reached the share, not how Immich stores it.
 */
export function uploadRefusal (link: SharedLink, keyType: KeyType, now: Dayjs = dayjs()): UploadRefusal | null {
  if (link.allowUpload !== true) return 'not-allowed'
  if (slugLinksDisabled(keyType)) return 'slug-disabled'

  // Nothing to file an upload into but the link itself, which an owner
  // rarely watches the way they watch an album
  if (getConfigOption('ipp.upload.albumOnly', true) !== false && link.type !== AlbumType.album) return 'not-album'

  // A slug is chosen to be readable and is therefore guessable
  // (`holiday-2026`); the generated key is sixty-odd characters of entropy.
  if (getConfigOption('ipp.upload.requireRandomKey', true) !== false && keyType === KeyType.slug) return 'slug'

  // Off by default: a password turns the link from a pure capability into
  // something that has to travel in two pieces
  if (getConfigOption('ipp.upload.requirePassword', false) === true && !isPasswordProtected(link)) return 'no-password'

  // An upload capability with no end date cannot be retracted, because nobody
  // knows who copied the URL. The horizon caps a leak at a known number of days.
  if (getConfigOption('ipp.upload.requireExpiry', true) !== false) {
    if (!link.expiresAt) return 'no-expiry'
    const expires = dayjs(link.expiresAt)
    if (!expires.isValid() || expires.isBefore(now)) return 'expired'
    const maxDays = getNumericConfigOption('ipp.upload.maxExpiryDays', 30)
    if (maxDays > 0 && expires.isAfter(now.add(maxDays, 'day'))) return 'expiry-too-far'
  }

  // The only cumulative limit: `maxFileSize` bounds one file, and without this
  // a leaked link is bounded only by free disk. Counting the album's own
  // assets keeps it stateless.
  const maxAssets = getNumericConfigOption('ipp.upload.maxAssets', 500)
  if (maxAssets > 0 && albumAssetCount(link) >= maxAssets) return 'album-full'

  return null
}

/** Refusals about the link rather than the file: once one applies, nothing else in a queue can succeed. */
export const LINK_REFUSALS: ReadonlySet<UploadRefusal> = new Set<UploadRefusal>([
  'not-allowed', 'slug-disabled', 'not-album', 'slug', 'no-password', 'no-expiry', 'expired', 'expiry-too-far', 'album-full'
])

/** The visitor-facing sentence for a refusal. */
export function uploadRefusalMessage (refusal: UploadRefusal): string {
  switch (refusal) {
    case 'album-full': return 'This album is full and accepts no more photos'
    case 'expired': return 'This share has expired'
    case 'slug': return 'Uploads need the share\'s full link, not its custom URL'
    default: return 'This share does not accept uploads'
  }
}
