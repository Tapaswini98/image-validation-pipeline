import type { VariantKind } from '@prisma/client';

/**
 * Deterministic keys derived only from the image id: re-running a stage overwrites the same
 * object instead of creating a new one, which is what makes reprocessing idempotent in S3.
 *
 *   pipeline/{imageId}/converted.jpg     intermediate (conversion output)
 *   pipeline/{imageId}/compressed.jpg    intermediate (compression output)
 *   variants/{imageId}/{thumbnail|web|full}.jpg
 */
export const convertedKey = (imageId: string) => `pipeline/${imageId}/converted.jpg`;
export const compressedKey = (imageId: string) => `pipeline/${imageId}/compressed.jpg`;
export const variantKey = (imageId: string, kind: VariantKind) =>
  `variants/${imageId}/${kind.toLowerCase()}.jpg`;
