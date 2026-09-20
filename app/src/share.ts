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
 * Decide whether visitors may upload into this share's album.
 *
 * Several independent conditions, and every one of them must hold. They are
 * not redundant: each closes a different way an upload link goes wrong once
 * it is out of your hands.
 *
 * A share key is a capability, not an identity. It travels in URLs, browser
 * history, group chats and screenshots, and anyone holding it can write. The
 * conditions below exist to bound what that costs you when - not if - one
 * ends up somewhere you did not intend.
 */
export function canUpload (share: SharedLink): boolean {
  // 1. The operator opted the instance in. Default false: a stock deployment
  //    of this fork behaves exactly like upstream.
  if (!getConfigOption('ipp.upload.enabled', false)) return false

  // 2. The share owner enabled uploads on this specific link, in Immich.
  //    Immich enforces this too (401 at POST /assets), so this is the UI gate
  //    plus defence in depth, never the only thing in the way.
  if (!share.allowUpload) return false

  // 3. Album shares only. Our restriction, not Immich's - it would happily
  //    append to an individual share's asset list, but a hand-picked set of
  //    photos is rarely something the owner meant to let others extend.
  if (share.type !== AlbumType.album) return false

  // 4. Random key only, never a slug. A slug is chosen to be readable and
  //    therefore guessable (`holiday-2026`); the generated key is 60-odd
  //    characters of entropy. Both are fine for reading, only one is a
  //    credential worth writing with. Slug links keep working - they just
  //    show no upload control.
  if (getConfigOption('ipp.upload.requireRandomKey', true) && share.keyType === KeyType.slug) {
    return false
  }

  // 5. The link must expire, and not in a geological timeframe. An upload
  //    capability with no end date is one you can never fully retract, since
  //    you cannot know who copied the URL. The horizon caps the blast radius
  //    of a leak at a known number of days.
  if (getConfigOption('ipp.upload.requireExpiry', true)) {
    if (!share.expiresAt) return false
    const expires = dayjs(share.expiresAt)
    if (!expires.isValid() || expires.isBefore(dayjs())) return false
    const maxDays = getNumericConfigOption('ipp.upload.maxExpiryDays', 30)
    if (maxDays > 0 && expires.isAfter(dayjs().add(maxDays, 'day'))) return false
  }

  // 6. Cumulative ceiling. The per-file size cap bounds ONE upload; nothing
  //    bounds how many. Without this, a leaked link is limited only by your
  //    free disk. Counting the album's own assets keeps that stateless - IPP
  //    stores nothing, and the count is refreshed on every successful upload.
  const maxAssets = getNumericConfigOption('ipp.upload.maxAssets', 500)
  if (maxAssets > 0 && share.assets.length >= maxAssets) return false

  return true
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
