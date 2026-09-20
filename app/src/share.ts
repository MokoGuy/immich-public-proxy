import { AlbumType, DownloadAll, KeyType, SharedLink } from './types'
import { getConfigOption, getNumericConfigOption } from './config/access'
import dayjs from 'dayjs'

/**
 * Display title for a shared link. Prefers the user-set link description,
 * falls back to the album name (for album shares), or a generic placeholder.
 * Used by the gallery view-model and as the zip filename in the download
 * pipeline.
 */
export function title (share: SharedLink): string {
  return share.description || share?.album?.albumName || 'Gallery'
}

/**
 * Decide whether the given shared link's download UI is shown (the "download
 * all" zip, multi-select download, and the per-asset lightbox button). The
 * `ipp.allowDownload` config controls the policy: disabled, follow the
 * per-share Immich setting, or always allowed. This is purely a UI gate - it
 * does not affect image quality (see `gallery/sizing.ts`).
 */
export function canDownload (share: SharedLink): boolean {
  const allowDownloadConfig = getConfigOption('ipp.allowDownload', 0) as DownloadAll
  if (!allowDownloadConfig) {
    // Downloading is disabled in config.json
    return false
  } else if (allowDownloadConfig === DownloadAll.always) {
    // Always allowed to download in config.json
    return true
  } else {
    // Return Immich's setting for this shared link
    return !!share.allowDownload
  }
}

/**
 * Why an upload into this share would be refused, or null if it would not.
 *
 * Every condition must hold. They are not redundant - each closes a different
 * way an upload link goes wrong once it is out of your hands. A share key is a
 * capability, not an identity: it travels in URLs, browser history, group
 * chats and screenshots, and anyone holding it can write.
 *
 * Returning a reason rather than a boolean is a UX decision. The gallery only
 * shows the upload control when uploads are possible, so most of these are
 * invisible - but `album-full` and `expired` are states a legitimate visitor
 * reaches mid-session, and "Upload failed" is a poor way to learn that the
 * album filled up while you were choosing photos.
 */
// disabled       operator has not opted this instance in
// not-allowed    owner did not enable uploads on this link
// not-album      individual share; nothing to file an upload into
// slug           readable key, refused for writes by policy
// no-password    operator requires password-protected links
// no-expiry      link never expires
// expired        link has expired
// expiry-too-far expiry beyond the configured horizon
// album-full     cumulative ceiling reached
export type UploadRefusal =
  | 'disabled'
  | 'not-allowed'
  | 'not-album'
  | 'slug'
  | 'no-password'
  | 'no-expiry'
  | 'expired'
  | 'expiry-too-far'
  | 'album-full'

export function uploadRefusal (share: SharedLink): UploadRefusal | null {
  if (!getConfigOption('ipp.upload.enabled', false)) return 'disabled'
  if (!share.allowUpload) return 'not-allowed'
  if (share.type !== AlbumType.album) return 'not-album'

  // A slug is chosen to be readable and is therefore guessable
  // (`holiday-2026`); the generated key is sixty-odd characters of entropy.
  // Both are fine for reading, only one is worth writing with.
  if (getConfigOption('ipp.upload.requireRandomKey', true) && share.keyType === KeyType.slug) {
    return 'slug'
  }

  // Off by default: a password turns the link from a pure capability into
  // something that has to travel in two pieces.
  if (getConfigOption('ipp.upload.requirePassword', false) && !share.password) {
    return 'no-password'
  }

  // An upload capability with no end date cannot be retracted, because you
  // cannot know who copied the URL. The horizon caps a leak at known days.
  if (getConfigOption('ipp.upload.requireExpiry', true)) {
    if (!share.expiresAt) return 'no-expiry'
    const expires = dayjs(share.expiresAt)
    if (!expires.isValid() || expires.isBefore(dayjs())) return 'expired'
    const maxDays = getNumericConfigOption('ipp.upload.maxExpiryDays', 30)
    if (maxDays > 0 && expires.isAfter(dayjs().add(maxDays, 'day'))) return 'expiry-too-far'
  }

  // The only cumulative limit. maxFileSizeMb bounds ONE file; without this a
  // leaked link is limited only by free disk. Counting the album's own assets
  // keeps it stateless - the count refreshes on every successful upload.
  const maxAssets = getNumericConfigOption('ipp.upload.maxAssets', 500)
  if (maxAssets > 0 && share.assets.length >= maxAssets) return 'album-full'

  return null
}

/** UI gate: show the upload control only when an upload would be accepted. */
export function canUpload (share: SharedLink): boolean {
  return uploadRefusal(share) === null
}

const DEFAULT_EXPIRY_FORMAT = 'YYYY-MM-DD'

/**
 * Formatted expiry date for the gallery subtitle, or undefined when the
 * feature is off, the share never expires, or the date can't be parsed.
 *
 * Gated by `ipp.gallery.showExpiryDate` (default `false`). Formatted with the
 * dayjs format string `ipp.gallery.expiryDateFormat` (default ISO 8601 date
 * `YYYY-MM-DD`, e.g. `2026-07-10`). Name-based tokens (e.g. `MMMM` -> "July")
 * render in the operator's `ipp.gallery.expiryDateLocale` when set, otherwise
 * dayjs's default English.
 */
export function expiryDate (share: SharedLink): string | undefined {
  if (!getConfigOption('ipp.gallery.showExpiryDate', false)) return undefined
  if (!share.expiresAt) return undefined
  const parsed = dayjs(share.expiresAt)
  if (!parsed.isValid()) return undefined
  const configured = getConfigOption('ipp.gallery.expiryDateFormat', DEFAULT_EXPIRY_FORMAT)
  const format = typeof configured === 'string' && configured ? configured : DEFAULT_EXPIRY_FORMAT
  const locale = expiryDateLocale()
  return (locale ? parsed.locale(locale) : parsed).format(format)
}

/**
 * Resolve and lazily load the dayjs locale named by `ipp.gallery.expiryDateLocale`
 * so name-based expiry tokens localise. Returns the locale name to apply, or
 * undefined to keep dayjs's default (English) - including when the value is not
 * a valid, bundled dayjs locale. Node caches the require, so repeat lookups for
 * the same locale are cheap.
 */
function expiryDateLocale (): string | undefined {
  const configured = getConfigOption('ipp.gallery.expiryDateLocale', '')
  if (typeof configured !== 'string' || !configured) return undefined
  // dayjs locale files are lowercase (e.g. `en-gb.js`); normalise `en-GB` etc.
  const name = configured.toLowerCase()
  // Constrain to dayjs-shaped locale names (e.g. `de`, `en-gb`, `pt-br`); this
  // also blocks the config value from reaching require() as a traversal path.
  if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(name)) return undefined
  try {
    require('dayjs/locale/' + name)
    return name
  } catch {
    return undefined
  }
}
