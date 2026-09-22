/*
 * Whether to hash a file before uploading it, to ask the owner whether they
 * already have these bytes.
 *
 * `crypto.subtle.digest` has no incremental form, so hashing means holding
 * the whole file in memory at once, on top of the File itself. A failed
 * allocation is caught and falls through to a normal upload - but a phone
 * that kills the tab instead is not something a `try` can recover from, and
 * the visitor loses the whole queue rather than one check.
 *
 * The cost of skipping is one re-uploaded duplicate. The cost of a dead tab
 * is every file still queued behind it. So above a ceiling, do not ask.
 */
export const CHECK_MAX_BYTES = 200 * 1024 * 1024

export function shouldPreCheck (sizeBytes: number, cryptoAvailable: boolean): boolean {
  if (!cryptoAvailable) return false
  // An empty file is rejected before this point; treat it as nothing to ask.
  if (sizeBytes <= 0) return false
  return sizeBytes <= CHECK_MAX_BYTES
}
