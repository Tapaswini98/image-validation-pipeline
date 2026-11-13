export type SupportedMimeType = 'image/jpeg' | 'image/png' | 'image/heic';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const GENERIC_HEIF_BRANDS = new Set(['mif1', 'msf1']); // also used by AVIF, so check compatible brands

/**
 * Detects the real file type from its magic bytes.
 *
 * Never trust the client: the Content-Type header and file extension are user-controlled
 * (a .exe renamed to .jpg arrives as image/jpeg). Browsers also often send HEIC as
 * "application/octet-stream" or an empty type, which made the old MIME check reject valid iPhone photos.
 */
export function detectImageType(buf: Buffer): SupportedMimeType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

  if (buf.length >= 8 && PNG_SIGNATURE.every((b, i) => buf[i] === b)) return 'image/png';

  // ISO-BMFF: [4-byte box size]["ftyp"][major brand][minor version][compatible brands...]
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const major = buf.toString('ascii', 8, 12);
    if (HEIC_BRANDS.has(major)) return 'image/heic';
    if (GENERIC_HEIF_BRANDS.has(major)) {
      const boxSize = Math.min(buf.readUInt32BE(0), buf.length);
      for (let off = 16; off + 4 <= boxSize; off += 4) {
        if (HEIC_BRANDS.has(buf.toString('ascii', off, off + 4))) return 'image/heic';
      }
    }
  }
  return null;
}
