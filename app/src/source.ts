import { getConfigOption } from './config/access'
import { APP_BUILD_DATE, APP_VERSION } from './version'

/*
 * AGPL-3.0 section 13.
 *
 * Upstream IPP is AGPL, so this fork is too. Section 13 goes further than the
 * usual copyleft obligation: running a MODIFIED version and letting people
 * interact with it over a network triggers a duty to offer those users the
 * Corresponding Source - "prominently", and for the version actually running,
 * not for whatever is on a default branch today.
 *
 * Having a public repository does not discharge that on its own. The offer has
 * to be reachable from the service itself, which is why every page a visitor
 * can land on carries the link below.
 *
 * `APP_VERSION` is the commit the image was built from (the Dockerfile bakes
 * PACKAGE_VERSION in, and CI passes the SHA), so the link points at the exact
 * revision serving the request.
 */

const DEFAULT_SOURCE_URL = 'https://github.com/MokoGuy/immich-public-proxy'

/** Repository root, overridable so a fork of this fork points at itself. */
export function sourceRepo (): string {
  const configured = getConfigOption('ipp.sourceUrl', DEFAULT_SOURCE_URL)
  const url = typeof configured === 'string' && configured ? configured : DEFAULT_SOURCE_URL
  return url.replace(/\/+$/, '')
}

/**
 * Link to the running revision. `/tree/<ref>` resolves for both a commit SHA
 * and a tag on the usual forges, so this works whether the image was built by
 * CI or tagged by hand. A local `npm run dev` build has no meaningful
 * revision, so it falls back to the repository root rather than linking to a
 * ref called "dev" that does not exist.
 */
export function sourceUrl (): string {
  const repo = sourceRepo()
  const ref = APP_VERSION
  if (!ref || ref === 'dev') return repo
  return `${repo}/tree/${encodeURIComponent(ref)}`
}

/**
 * What the footer reads: `IPP 3.3.1-upload.2 (2026-09-21)`.
 *
 * The version alone does not say whether what is running is a week or a year
 * old, and a bare 40-character SHA says nothing at all to a human - so a
 * commit build is abbreviated and the build date carries the rest.
 */
export function sourceLabel (): string {
  const ref = APP_VERSION
  if (!ref || ref === 'dev') return APP_BUILD_DATE ? `IPP (${APP_BUILD_DATE})` : 'IPP'
  const short = /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref
  return APP_BUILD_DATE ? `IPP ${short} (${APP_BUILD_DATE})` : `IPP ${short}`
}
