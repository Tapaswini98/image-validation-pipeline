import sharp from 'sharp';
import heicConvert from 'heic-convert';

/** Decompression-bomb guard (same limit as validation). */
const MAX_INPUT_PIXELS = 80_000_000;

/** The input can never be processed (corrupt, unsupported): fail the job, don't retry. */
export class UnprocessableImageError extends Error {}

export interface EncodedImage {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Conversion: any supported upload -> one canonical format, so later stages only ever see
 * sRGB JPEG. EXIF orientation applied, metadata stripped (sharp's default), alpha flattened
 * onto white. Quality 95 / 4:4:4: this is the high-quality master, compression happens next.
 */
export async function convertToJpeg(input: Buffer, mime: string): Promise<EncodedImage> {
  let source = input;
  if (mime === 'image/heic') {
    // Prebuilt sharp has no HEVC decoder (patent licensing): heic-convert is libheif in wasm.
    try {
      source = Buffer.from(await heicConvert({ buffer: input, format: 'JPEG', quality: 0.95 }));
    } catch (err) {
      throw new UnprocessableImageError(`HEIC to JPEG conversion failed: ${(err as Error).message}`);
    }
  }
  try {
    const { data, info } = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (err) {
    throw new UnprocessableImageError(`Image could not be decoded: ${(err as Error).message}`);
  }
}

/** Compression: mozjpeg (trellis quantisation, progressive) at a perceptually safe quality. */
export async function compressJpeg(master: Buffer, quality: number): Promise<EncodedImage> {
  const { data, info } = await sharp(master)
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Variant: resized from the high-quality master (not the compressed file) to avoid double lossy encoding. */
export async function resizeJpeg(master: Buffer, maxSide: number, quality: number): Promise<EncodedImage> {
  const { data, info } = await sharp(master)
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
