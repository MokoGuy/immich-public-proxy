/*
  Magic-byte check of an upload's first bytes against its declared type.

  Immich decides an asset's type from the filename extension and does not
  look at the bytes on the way in, so `PK\x03\x04...` sent as `payload.png`
  is accepted and stored. On an anonymous upload route that means anyone
  holding the link can park arbitrary content in the owner's library, found
  only when thumbnail generation fails.

  The rule is one-sided on purpose: a known signature that does not match is
  refused; a type this table does not know (camera RAW, MPEG-TS, ...) passes,
  and Immich still gates on the extension.
*/

/** How many leading bytes the check needs. */
export const SNIFF_BYTES = 16

/** Whether `head` (the file's first bytes) is plausibly of `mimeType`. */
export function matchesDeclaredType (mimeType: string, head: Uint8Array): boolean {
  const type = (mimeType || '').split(';')[0].trim().toLowerCase()
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b)
  const at = (offset: number, ascii: string) => {
    if (head.length < offset + ascii.length) return false
    for (let i = 0; i < ascii.length; i++) if (head[offset + i] !== ascii.charCodeAt(i)) return false
    return true
  }

  switch (type) {
    case 'image/png': return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'image/jpeg': return starts(0xff, 0xd8, 0xff)
    case 'image/gif': return at(0, 'GIF8')
    case 'image/webp': return at(0, 'RIFF') && at(8, 'WEBP')
    case 'image/tiff': return starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)
    case 'image/bmp': return at(0, 'BM')
    // ISO base media: HEIC/HEIF/AVIF and the MP4/MOV family all carry `ftyp`
    case 'image/heic':
    case 'image/heif':
    case 'image/avif':
    case 'video/mp4':
    case 'video/quicktime': return at(4, 'ftyp')
    case 'video/x-matroska':
    case 'video/webm': return starts(0x1a, 0x45, 0xdf, 0xa3)
    // Unknown here; Immich still gates on the extension
    default: return true
  }
}
