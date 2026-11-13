import type { RejectionCode } from '@prisma/client';

/** Bounding box as ratios of image width/height (0..1), the format Rekognition returns. */
export interface DetectedFace {
  confidence: number; // 0..100
  box: { left: number; top: number; width: number; height: number };
}

export interface FaceRuleConfig {
  minConfidence: number;
  minAreaRatio: number;
  minSizePx: number;
}

export type FaceVerdict =
  | { ok: true; faceCount: 1; faceAreaRatio: number }
  | { ok: false; code: RejectionCode; reason: string; faceCount: number; faceAreaRatio?: number };

/**
 * Pure decision function, deliberately separate from the detector so the rules are unit-testable
 * and the detector (Rekognition today) can be swapped for a local model without touching them.
 */
export function evaluateFaces(
  faces: DetectedFace[],
  image: { width: number; height: number },
  cfg: FaceRuleConfig,
): FaceVerdict {
  // Ignore low-confidence detections (patterns in wallpaper, posters, etc.)
  const confident = faces.filter((f) => f.confidence >= cfg.minConfidence);

  if (confident.length === 0) {
    return {
      ok: false,
      code: 'NO_FACE',
      reason: 'No face detected. Upload a photo where your face is clearly visible.',
      faceCount: 0,
    };
  }
  if (confident.length > 1) {
    return {
      ok: false,
      code: 'MULTIPLE_FACES',
      reason: `${confident.length} faces detected. Upload photos with only you in them.`,
      faceCount: confident.length,
    };
  }

  const { box } = confident[0];
  const faceAreaRatio = box.width * box.height;
  const faceWidthPx = box.width * image.width;
  const faceHeightPx = box.height * image.height;

  // Two conditions: relative size (face fills enough of the frame) AND absolute size
  // (enough pixels on the face for downstream use, e.g. model training).
  if (faceAreaRatio < cfg.minAreaRatio || Math.min(faceWidthPx, faceHeightPx) < cfg.minSizePx) {
    return {
      ok: false,
      code: 'FACE_TOO_SMALL',
      reason: `Face is too small (${formatPercent(faceAreaRatio)} of the photo, ${Math.round(faceWidthPx)}px wide). Move closer or crop the photo.`,
      faceCount: 1,
      faceAreaRatio,
    };
  }

  return { ok: true, faceCount: 1, faceAreaRatio };
}

/** 0.005 -> "0.5%", 0.14 -> "14%": small values keep a decimal so they never read as "0%". */
function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}
