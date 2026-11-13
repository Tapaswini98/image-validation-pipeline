/**
 * Short label under each rejected photo + a friendly fallback explanation for the tooltip.
 * The tooltip prefers the server's specific reason (it has the measured numbers).
 */
const COPY: Record<string, { label: string; tip: string }> = {
  BLURRY: { label: 'Blurry face detected', tip: 'We detected a blurry face. Please make sure your face is in focus.' },
  FACE_TOO_SMALL: {
    label: 'Face is too far away',
    tip: 'Your face is too far from the camera. Use a closer shot or crop the photo.',
  },
  DUPLICATE: {
    label: 'Too similar to another upload',
    tip: "You've already uploaded a photo very similar to this one. Try photos with different backgrounds, lighting and clothing.",
  },
  MULTIPLE_FACES: { label: 'Multiple faces detected', tip: 'Only you should be in the photo.' },
  NO_FACE: { label: 'No face detected', tip: "We couldn't find a face. Make sure your face is clearly visible." },
  RESOLUTION_TOO_LOW: { label: 'Resolution too low', tip: 'Use a larger, higher-quality photo.' },
  FILE_TOO_SMALL: { label: 'File too small', tip: 'This file is too small to be a usable photo.' },
  FILE_TOO_LARGE: { label: 'File too large', tip: 'Photos must be 20 MB or smaller.' },
  UNSUPPORTED_FORMAT: { label: 'Unsupported format', tip: 'Only JPG, PNG and HEIC photos are supported.' },
  CORRUPT_IMAGE: { label: "Couldn't read this file", tip: 'The file seems to be damaged. Try exporting it again.' },
  FAILED: { label: "Couldn't check this photo", tip: 'Something went wrong on our side. Please retry.' },
};

export function rejectionCopy(code: string | undefined, reason: string | undefined) {
  const c = (code && COPY[code]) || { label: 'Not accepted', tip: 'This photo did not pass our checks.' };
  return { label: c.label, tip: reason ?? c.tip };
}
