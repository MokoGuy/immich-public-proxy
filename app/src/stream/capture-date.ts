import ExifReader from 'exifreader'
import { log } from '../utils/log'

/*
 * Work out when a photo was actually taken.
 *
 * Immich derives an asset's date from EXIF when it can, and falls back to the
 * `fileCreatedAt` we send. The browser has nothing better to offer for that
 * field than `File.lastModified`, and for a file handed over by the Android
 * photo picker that is the moment the picker exported a copy - so a photo
 * taken days ago arrives dated "now".
 *
 * Immich only consults the capture tags (DateTimeOriginal, CreateDate). It
 * deliberately ignores DateTime - "ModifyDate" in exiftool's naming - because
 * in general that is an edit timestamp rather than a capture one. But the
 * Android picker produces exactly the file where DateTimeOriginal is gone and
 * DateTime survives, and there an edit timestamp days before the upload still
 * beats the upload clock. So we read it, and send it as `fileCreatedAt`:
 * Immich keeps our value precisely because it has nothing of its own.
 *
 * Only images are inspected. Video capture times live in container atoms this
 * does not read, and Immich does read them - reporting "no date" for a video
 * would be us failing to look, not the file failing to say.
 */

export type DateSource =
  | 'exif-original' // DateTimeOriginal - the real thing
  | 'exif-create' // CreateDate / DateTimeDigitized
  | 'exif-modify' // DateTime, salvaged when the capture tags are gone
  | 'client' // nothing in the file; the browser's lastModified stands
  | 'not-inspected' // video, or a format we do not read

export interface CaptureDate { iso: string, source: DateSource }

/** EXIF dates are `YYYY:MM:DD HH:MM:SS` wall clock with no zone of their own. */
const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
const OFFSET = /^([+-]\d{2}):?(\d{2})$/

function toIso (raw: unknown, offset: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const m = EXIF_DATE.exec(raw.trim())
  if (!m) return undefined
  const [, y, mo, d, h, mi, s] = m
  /*
   * With no offset tag the wall clock is all we have. Labelling it UTC keeps
   * the digits the photographer saw: Immich stores the instant and, absent a
   * timezone for the asset, displays it unshifted. Guessing the proxy's own
   * zone instead would silently move the photo by however many hours the
   * server happens to be from the visitor.
   */
  let zone = 'Z'
  if (typeof offset === 'string') {
    const o = OFFSET.exec(offset.trim())
    if (o) zone = `${o[1]}:${o[2]}`
  }
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`
  const parsed = new Date(iso)
  if (isNaN(parsed.getTime())) return undefined
  // A capture date in the future is a broken clock, not a capture date.
  if (parsed.getTime() > Date.now() + 86_400_000) return undefined
  return parsed.toISOString()
}

const value = (tags: Record<string, { description?: unknown, value?: unknown }>, name: string): unknown => {
  const tag = tags[name]
  if (!tag) return undefined
  if (typeof tag.description === 'string') return tag.description
  return Array.isArray(tag.value) ? tag.value[0] : tag.value
}

/**
 * Pick the best capture date available, falling back to what the client sent.
 * Never throws: a file we cannot read is a file we have no opinion about.
 */
export function captureDate (head: Buffer, contentType: string, clientIso: string): CaptureDate {
  if (!/^image\//.test(contentType)) return { iso: clientIso, source: 'not-inspected' }

  let tags: Record<string, { description?: unknown, value?: unknown }>
  try {
    tags = ExifReader.load(head) as typeof tags
  } catch (e) {
    // Includes the ordinary "no EXIF here" case, which is not an anomaly.
    return { iso: clientIso, source: 'client' }
  }

  const offset = value(tags, 'OffsetTimeOriginal') ?? value(tags, 'OffsetTime')
  const candidates: Array<[DateSource, unknown, unknown]> = [
    ['exif-original', value(tags, 'DateTimeOriginal'), offset],
    ['exif-create', value(tags, 'CreateDate') ?? value(tags, 'DateTimeDigitized'), value(tags, 'OffsetTimeDigitized') ?? offset],
    ['exif-modify', value(tags, 'DateTime') ?? value(tags, 'ModifyDate'), value(tags, 'OffsetTime')]
  ]
  for (const [source, raw, off] of candidates) {
    const iso = toIso(raw, off)
    if (iso) return { iso, source }
  }
  return { iso: clientIso, source: 'client' }
}

let warned = false
/** One line if the parser ever misbehaves, so it cannot flood. */
export function noteParserFailure (): void {
  if (warned) return
  warned = true
  log.warn('EXIF inspection failed; uploads continue with the date the browser supplied')
}
