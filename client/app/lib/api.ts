import { API_URL } from './config';
import type { ImagePage, ServerImage } from './types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    throw new ApiError(msg ?? `Request failed (${res.status})`, res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/**
 * XHR rather than fetch: fetch still has no upload-progress events, and per-file
 * progress bars are part of the "real-time feedback" requirement.
 */
export function uploadImage(
  file: File,
  collectionId: string,
  onProgress: (fraction: number) => void,
): Promise<ServerImage> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/images`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response as ServerImage);
      const msg =
        xhr.status === 413
          ? 'File is too large.'
          : xhr.status === 429
            ? 'Too many uploads, slow down and retry.'
            : (xhr.response?.message ?? `Upload failed (${xhr.status})`);
      reject(new ApiError(Array.isArray(msg) ? msg.join(', ') : msg, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Network error, check your connection.', 0));
    const body = new FormData();
    body.append('collectionId', collectionId);
    body.append('file', file);
    xhr.send(body);
  });
}

export async function listImages(params: {
  collectionId: string;
  ids?: string[];
  cursor?: string | null;
  limit?: number;
}): Promise<ImagePage> {
  const qs = new URLSearchParams({ collectionId: params.collectionId });
  if (params.ids?.length) qs.set('ids', params.ids.join(','));
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  return json(await fetch(`${API_URL}/images?${qs}`, { cache: 'no-store' }));
}

export async function retryImage(id: string): Promise<ServerImage> {
  return json(await fetch(`${API_URL}/images/${id}/retry`, { method: 'POST' }));
}

export async function deleteImage(id: string): Promise<void> {
  return json(await fetch(`${API_URL}/images/${id}`, { method: 'DELETE' }));
}
