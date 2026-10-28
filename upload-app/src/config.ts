import { getConfigOption, getNumericConfigOption } from '@ipp/core'
import { DEFAULT_FIELD_SEPARATOR, isUsableSeparator } from './filename'

const MB = 1024 * 1024

/**
 * IPP's public URL from `PUBLIC_BASE_URL`, without a trailing slash, or
 * undefined when unset. The same name and value as on the IPP container, so
 * the two environment blocks in a compose file match.
 */
export function galleryUrl (): string | undefined {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || undefined
}

/** Largest single file accepted, in bytes, from `ipp.upload.maxFileSize` (MB). */
export function maxFileSize (): number {
  return Math.max(1, getNumericConfigOption('ipp.upload.maxFileSize', 500)) * MB
}

/** Files per minute per visitor address and share, from `ipp.upload.rateLimit`. `0` is no limit. */
export function rateLimit (): number {
  return getNumericConfigOption('ipp.upload.rateLimit', 60)
}

/** Bytes accepted per share per hour, from `ipp.upload.byteBudget` (MB). `0` is no limit. */
export function byteBudget (): number {
  return Math.max(0, getNumericConfigOption('ipp.upload.byteBudget', 10240)) * MB
}

/** Requests that may write to Immich at once, from `ipp.upload.maxConcurrent`. */
export function maxConcurrent (): number {
  return Math.max(1, Math.floor(getNumericConfigOption('ipp.upload.maxConcurrent', 2)))
}

/** How long a request holding an upload slot may go without a byte either way, from `ipp.upload.idleTimeoutSeconds`. */
export function slotIdleMs (): number {
  return Math.max(10, getNumericConfigOption('ipp.upload.idleTimeoutSeconds', 120)) * 1000
}

/** The longest one request may hold an upload slot, from `ipp.upload.maxDurationSeconds`. */
export function slotMaxMs (): number {
  return Math.max(60, getNumericConfigOption('ipp.upload.maxDurationSeconds', 1800)) * 1000
}

/** Prefix for every stored filename, from `ipp.upload.filenamePrefix`. */
export function filenamePrefix (): string {
  const configured = getConfigOption('ipp.upload.filenamePrefix', 'ipp_upload_')
  return typeof configured === 'string' ? configured : ''
}

/** Whether the upload page asks the visitor's name, from `ipp.upload.askName`. */
export function askName (): boolean {
  return getConfigOption('ipp.upload.askName', true) !== false
}

/**
 * The string that ends each visitor field in a stored filename, from
 * `ipp.upload.fieldSeparator`. The default when the configured value could be
 * part of a field or a filename, or is in the prefix, see `isUsableSeparator`.
 */
export function fieldSeparator (): string {
  const configured = getConfigOption('ipp.upload.fieldSeparator', DEFAULT_FIELD_SEPARATOR)
  return isUsableSeparator(configured, filenamePrefix()) ? configured : DEFAULT_FIELD_SEPARATOR
}

/** Text shown under the placeholder on the upload page, from `ipp.upload.notice`. Empty hides it. */
export function uploadNotice (): string {
  const configured = getConfigOption('ipp.upload.notice', 'Uploaded photos may not appear in the gallery immediately.')
  return typeof configured === 'string' ? configured : ''
}

/** Notification webhook settings from `ipp.upload.notify*`, or undefined when no URL is set. */
export function notifyConfig (): { url: string, headers: Record<string, string>, timeoutMs: number } | undefined {
  const url = getConfigOption('ipp.upload.notifyUrl', '')
  if (typeof url !== 'string' || !url) return undefined
  const headers: Record<string, string> = {}
  const configured = getConfigOption('ipp.upload.notifyHeaders', {})
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
    for (const [name, value] of Object.entries(configured as Record<string, unknown>)) {
      if (typeof value === 'string') headers[name] = value
    }
  }
  return { url, headers, timeoutMs: getNumericConfigOption('ipp.upload.notifyTimeout', 10_000) }
}
