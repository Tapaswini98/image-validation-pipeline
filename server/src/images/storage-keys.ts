/**
 * Object keys are derived only from the server-generated image id: the user's filename never
 * becomes part of a key, so there is no path traversal or key collision to worry about.
 */
export const originalKey = (id: string) => `originals/${id}`;
export const thumbnailKey = (id: string) => `thumbnails/${id}.jpg`;
export const processedKey = (id: string, mime: 'image/jpeg' | 'image/png') =>
  `processed/${id}.${mime === 'image/png' ? 'png' : 'jpg'}`;
