import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Resolve the running application version. Prefers the APP_VERSION env var
 * baked in at Docker build time (see Dockerfile); falls back to package.json
 * for local dev (`npm run dev`), and finally to 'dev' if neither is readable.
 */
function resolveVersion (): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    return pkg.version || 'dev'
  } catch {
    return 'dev'
  }
}

export const APP_VERSION = resolveVersion()

/**
 * Date the image was built, `YYYY-MM-DD`, or undefined outside a built image.
 * Baked in by the Dockerfile; a version string alone does not tell you
 * whether what is running is a week or a year old.
 */
export const APP_BUILD_DATE = (() => {
  const raw = process.env.APP_BUILD_DATE
  if (!raw) return undefined
  const d = new Date(raw)
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10)
})()

/** URL-safe cache-busting segment for static asset paths. */
export const ASSET_VERSION = encodeURIComponent(APP_VERSION)
