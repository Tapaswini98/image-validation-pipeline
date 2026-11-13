export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Client checks mirror the server's defaults for instant feedback. The server stays the
 * authority: these exist only for UX and are trivially bypassable.
 */
export const LIMITS = {
  minFileBytes: 10 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  minDimensionPx: 512,
  maxFilesPerDrop: 50,
  uploadConcurrency: 4,
  pollIntervalMs: 1500,
};

/** Photo-set goal shown in the progress bar: at least `min` accepted photos, ideally `target`. */
export const PHOTO_GOAL = { min: 6, target: 10 };
