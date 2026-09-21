/*
 * Build tiny JPEGs carrying chosen EXIF date tags.
 *
 * Generated rather than committed as binaries so a test states exactly what it
 * exercises. Three shapes occur in the wild: capture date present, only
 * DateTime surviving the Android photo picker, and no EXIF at all.
 */

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA' +
  'AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx' +
  'BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK' +
  'U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3' +
  'uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii' +
  'gD//2Q==', 'base64')

interface Entry { tag: number, ascii: string }

function packIfd (entries: Entry[], base: number, pointers: number[] = []): { body: Buffer, data: Buffer } {
  const count = entries.length + pointers.length / 2
  const body = Buffer.alloc(2 + 12 * count + 4)
  body.writeUInt16LE(count, 0)
  const chunks: Buffer[] = []
  let dataLen = 0
  const dataBase = base + body.length
  let at = 2
  for (const e of entries) {
    const value = Buffer.from(e.ascii + '\0', 'latin1')
    body.writeUInt16LE(e.tag, at)
    body.writeUInt16LE(2, at + 2)
    body.writeUInt32LE(value.length, at + 4)
    if (value.length <= 4) value.copy(body, at + 8)
    else { body.writeUInt32LE(dataBase + dataLen, at + 8); chunks.push(value); dataLen += value.length }
    at += 12
  }
  for (let i = 0; i < pointers.length; i += 2) {
    body.writeUInt16LE(pointers[i], at)
    body.writeUInt16LE(4, at + 2)
    body.writeUInt32LE(1, at + 4)
    body.writeUInt32LE(pointers[i + 1], at + 8)
    at += 12
  }
  return { body, data: Buffer.concat(chunks) }
}

/** A JPEG whose EXIF carries exactly the tags given, and nothing else. */
export function jpegWithExif (ifd0: Array<[number, string]>, sub: Array<[number, string]> = []): Buffer {
  const ifd0Entries: Entry[] = ifd0.map(([tag, ascii]) => ({ tag, ascii }))
  const subEntries: Entry[] = sub.map(([tag, ascii]) => ({ tag, ascii }))

  // Lay IFD0 out once to learn its size, so the sub-IFD offset is known.
  const probe = packIfd(ifd0Entries, 8, subEntries.length ? [0x8769, 0] : [])
  const subBase = 8 + probe.body.length + probe.data.length
  const first = packIfd(ifd0Entries, 8, subEntries.length ? [0x8769, subBase] : [])
  const subIfd = subEntries.length
    ? packIfd(subEntries, subBase)
    : { body: Buffer.alloc(0), data: Buffer.alloc(0) }

  const header = Buffer.alloc(8)
  header.write('II', 0, 'latin1')
  header.writeUInt16LE(42, 2)
  header.writeUInt32LE(8, 4)
  const tiff = Buffer.concat([header, first.body, first.data, subIfd.body, subIfd.data])

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.alloc(4)
  app1.writeUInt16BE(0xffe1, 0)
  app1.writeUInt16BE(payload.length + 2, 2)

  // After the JFIF APP0 segment, where readers expect it.
  const at = 4 + TINY_JPEG.readUInt16BE(4)
  return Buffer.concat([TINY_JPEG.subarray(0, at), app1, payload, TINY_JPEG.subarray(at)])
}

export const TAG = {
  make: 0x010f,
  model: 0x0110,
  modifyDate: 0x0132,
  dateTimeOriginal: 0x9003,
  createDate: 0x9004,
  offsetTimeOriginal: 0x9011
}

/** No EXIF block whatsoever - a screenshot, or an image the picker re-encoded. */
export const jpegWithoutExif = (): Buffer => Buffer.from(TINY_JPEG)
