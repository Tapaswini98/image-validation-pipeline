import sharp from 'sharp';
import heicConvert from 'heic-convert';
import type { SupportedMimeType } from '../validation/file-signature';
import { regionalSharpness } from '../validation/sharpness';
import { DHASH_HEIGHT, DHASH_WIDTH, dHashFromGray } from '../validation/perceptual-hash';

/** Decompression-bomb guard: refuse anything over ~80 MP (a 48 MP iPhone photo is fine). */
const MAX_INPUT_PIXELS = 80_000_000;
/** Sharpness is measured at a fixed size so the score doesn't depend on the upload's resolution. */
const SHARPNESS_ANALYSIS_SIZE = 1024;
const THUMBNAIL_SIZE = 400;
/** Rekognition accepts at most 5 MB of image bytes; 1600px JPEG is far below that and plenty for faces. */
const FACE_DETECTION_SIZE = 1600;

export class CorruptImageError extends Error {}

export interface DecodedImage {
  /** Normalised output: EXIF-oriented, metadata (GPS etc.) stripped. HEIC -> JPEG, PNG stays PNG. */
  processed: Buffer;
  processedMimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  thumbnail: Buffer; // JPEG
  faceDetectionInput: Buffer; // JPEG, <= 1600px
  blurScore: number;
  perceptualHash: bigint;
}

export async function decodeImage(original: Buffer, mime: SupportedMimeType): Promise<DecodedImage> {
  let source = original;
  if (mime === 'image/heic') {
    // Prebuilt sharp/libvips ships without the HEVC decoder (patent licensing), so HEIC
    // is converted with heic-convert (libheif compiled to wasm). CPU-heavy, one of the
    // reasons processing runs in a background worker and not in the request.
    try {
      source = Buffer.from(await heicConvert({ buffer: original, format: 'JPEG', quality: 0.92 }));
    } catch (err) {
      throw new CorruptImageError(`HEIC decode failed: ${(err as Error).message}`);
    }
  }

  const processedMimeType = mime === 'image/png' ? 'image/png' : 'image/jpeg';

  let processed: Buffer;
  let width: number;
  let height: number;
  try {
    // .rotate() with no args applies the EXIF orientation; sharp drops all metadata on output
    // by default, which strips GPS location and camera details (privacy).
    const pipeline = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    const out = await (
      processedMimeType === 'image/png'
        ? pipeline.png({ compressionLevel: 9 })
        : pipeline.jpeg({ quality: 90, mozjpeg: true })
    ).toBuffer({ resolveWithObject: true });
    processed = out.data;
    width = out.info.width;
    height = out.info.height;
  } catch (err) {
    throw new CorruptImageError(`Image decode failed: ${(err as Error).message}`);
  }

  const [thumbnail, faceDetectionInput, sharpnessGray, hashGray] = await Promise.all([
    sharp(processed)
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside' })
      .jpeg({ quality: 75 })
      .toBuffer(),
    sharp(processed)
      .resize(FACE_DETECTION_SIZE, FACE_DETECTION_SIZE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer(),
    sharp(processed)
      .resize(SHARPNESS_ANALYSIS_SIZE, SHARPNESS_ANALYSIS_SIZE, { fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(processed).resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' }).grayscale().raw().toBuffer(),
  ]);

  return {
    processed,
    processedMimeType,
    width,
    height,
    thumbnail,
    faceDetectionInput,
    blurScore: regionalSharpness(sharpnessGray.data, sharpnessGray.info.width, sharpnessGray.info.height),
    perceptualHash: dHashFromGray(hashGray),
  };
}
