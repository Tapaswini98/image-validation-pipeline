import { LIMITS } from './config';

const EXT = /\.(jpe?g|png|heic|heif)$/i;
const MIME = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif']);

export function isHeic(file: File): boolean {
  return /\.(heic|heif)$/i.test(file.name) || file.type === 'image/heic' || file.type === 'image/heif';
}

/**
 * Instant pre-upload checks. Extension OR MIME: browsers frequently report HEIC as ""
 * or "application/octet-stream", so MIME alone would wrongly reject iPhone photos.
 */
function looksLikeSupportedImage(file: File): boolean {
  return MIME.has(file.type) || EXT.test(file.name);
}

/** Same codes as the server's RejectionCode, so the UI labels rejections identically wherever they happened. */
export interface ClientRejection {
  code: 'UNSUPPORTED_FORMAT' | 'FILE_TOO_SMALL' | 'FILE_TOO_LARGE' | 'RESOLUTION_TOO_LOW' | 'CORRUPT_IMAGE';
  reason: string;
}

export async function checkFile(file: File): Promise<ClientRejection | null> {
  if (!looksLikeSupportedImage(file)) {
    return { code: 'UNSUPPORTED_FORMAT', reason: 'Unsupported format. Use JPEG, PNG or HEIC.' };
  }
  if (file.size < LIMITS.minFileBytes) {
    return {
      code: 'FILE_TOO_SMALL',
      reason: `File is too small (${formatBytes(file.size)}). Minimum is ${formatBytes(LIMITS.minFileBytes)}.`,
    };
  }
  if (file.size > LIMITS.maxFileBytes) {
    return {
      code: 'FILE_TOO_LARGE',
      reason: `File is too large (${formatBytes(file.size)}). Maximum is ${formatBytes(LIMITS.maxFileBytes)}.`,
    };
  }
  // Resolution: browsers decode JPEG/PNG natively (HEIC is checked server-side).
  if (!isHeic(file)) {
    try {
      const bmp = await createImageBitmap(file);
      const { width, height } = bmp;
      bmp.close();
      if (Math.min(width, height) < LIMITS.minDimensionPx) {
        return {
          code: 'RESOLUTION_TOO_LOW',
          reason: `Resolution too low (${width}×${height}). The shortest side must be at least ${LIMITS.minDimensionPx}px.`,
        };
      }
    } catch {
      return { code: 'CORRUPT_IMAGE', reason: 'This file could not be read as an image. It may be corrupted.' };
    }
  }
  return null;
}

/** Browsers can't render HEIC; convert a preview copy client-side (lazy-loaded, ~1 MB library). */
export async function previewUrlFor(file: File): Promise<string | undefined> {
  if (!looksLikeSupportedImage(file)) return undefined;
  if (!isHeic(file)) return URL.createObjectURL(file);
  try {
    const { default: heic2any } = await import('heic2any');
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.6 });
    return URL.createObjectURL(Array.isArray(out) ? out[0] : out);
  } catch {
    return undefined; // server thumbnail will be shown once processed
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
