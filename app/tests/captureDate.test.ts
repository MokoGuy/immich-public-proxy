import { describe, expect, it } from 'vitest'
import { captureDate } from '../src/stream/capture-date'
import { jpegWithExif, jpegWithoutExif, TAG } from './fixtures/exifJpeg'

/*
 * Observed in production: of 30 guest uploads, 26 carried DateTimeOriginal and
 * were dated correctly, while 4 had none and were stamped with the moment they
 * were uploaded. Three of those four still carried DateTime - the Android
 * photo picker hands over a copy that keeps Make/Model and loses the capture
 * tags - pointing at a date three days earlier than the album showed.
 */

const CLIENT = '2026-09-21T10:49:00.000Z'
const CAMERA: Array<[number, string]> = [[TAG.make, 'Google'], [TAG.model, 'Pixel 8a']]

describe('captureDate', () => {
  it('prefers the real capture tag', () => {
    const jpeg = jpegWithExif(CAMERA, [
      [TAG.dateTimeOriginal, '2026:09:20 12:27:53'],
      [TAG.offsetTimeOriginal, '+02:00']
    ])
    const out = captureDate(jpeg, 'image/jpeg', CLIENT)
    expect(out.source).toBe('exif-original')
    expect(out.iso).toBe('2026-09-20T10:27:53.000Z')
  })

  it('salvages DateTime when the picker stripped the capture tags', () => {
    // Exactly 1000029619.jpg: camera tags intact, no DateTimeOriginal, and a
    // DateTime three days before the upload. Immich ignores DateTime, so
    // without this the album shows the photo as taken on upload day.
    const jpeg = jpegWithExif([...CAMERA, [TAG.modifyDate, '2026:09:18 04:24:13']])
    const out = captureDate(jpeg, 'image/jpeg', CLIENT)
    expect(out.source).toBe('exif-modify')
    expect(out.iso).toBe('2026-09-18T04:24:13.000Z')
    expect(out.iso).not.toBe(CLIENT)
  })

  it('falls back to the browser when the file carries no EXIF at all', () => {
    const out = captureDate(jpegWithoutExif(), 'image/jpeg', CLIENT)
    expect(out.source).toBe('client')
    expect(out.iso).toBe(CLIENT)
  })

  it('does not claim a video has no date - it does not read video metadata', () => {
    // Immich does read container atoms. Reporting "no date" here would be the
    // proxy failing to look, not the file failing to say, and it would warn
    // the visitor about a problem that does not exist.
    const out = captureDate(jpegWithoutExif(), 'video/mp4', CLIENT)
    expect(out.source).toBe('not-inspected')
    expect(out.iso).toBe(CLIENT)
  })

  it('keeps the wall clock when the file states no offset', () => {
    const jpeg = jpegWithExif(CAMERA, [[TAG.dateTimeOriginal, '2026:09:20 12:27:53']])
    const out = captureDate(jpeg, 'image/jpeg', CLIENT)
    // Same digits the photographer saw. Guessing the proxy's own zone would
    // move the photo by however far the server is from the visitor.
    expect(out.iso).toBe('2026-09-20T12:27:53.000Z')
  })

  it('rejects a capture date from a broken clock in the future', () => {
    const future = new Date(Date.now() + 40 * 86400_000)
    const stamp = future.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':')
    const jpeg = jpegWithExif(CAMERA, [[TAG.dateTimeOriginal, stamp]])
    const out = captureDate(jpeg, 'image/jpeg', CLIENT)
    expect(out.source).toBe('client')
  })

  it('survives a truncated or corrupt head without failing the upload', () => {
    const jpeg = jpegWithExif(CAMERA, [[TAG.dateTimeOriginal, '2026:09:20 12:27:53']])
    const out = captureDate(jpeg.subarray(0, 24), 'image/jpeg', CLIENT)
    expect(out.iso).toBe(CLIENT)
  })
})
