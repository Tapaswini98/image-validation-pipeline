/** Mirrors the server's ImageDto. */
export type ServerStatus = 'PENDING' | 'PROCESSING' | 'ACCEPTED' | 'REJECTED' | 'FAILED';

export interface ServerImage {
  id: string;
  collectionId: string;
  filename: string;
  status: ServerStatus;
  rejectionCode: string | null;
  rejectionReason: string | null;
  mimeType: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  metrics: { blurScore: number | null; faceCount: number | null; faceAreaRatio: number | null };
  url: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface ImagePage {
  items: ServerImage[];
  nextCursor: string | null;
}

/**
 * Client-side lifecycle of one file:
 *
 *   validating -> invalid                      (failed a client check, never uploaded)
 *              -> queued -> uploading -> processing -> accepted | rejected | failed
 *                                     -> upload-error (network/server error, retryable)
 */
export type EntryPhase =
  | 'validating'
  | 'invalid'
  | 'queued'
  | 'uploading'
  | 'upload-error'
  | 'processing'
  | 'accepted'
  | 'rejected'
  | 'failed';

export interface UploadEntry {
  localId: string;
  file?: File; // absent for images loaded from history
  filename: string;
  sizeBytes: number;
  phase: EntryPhase;
  progress: number; // 0..1, upload progress
  reason?: string;
  reasonCode?: string; // RejectionCode, from the server or the client-side checks
  previewUrl?: string; // local object URL (revoked on removal)
  server?: ServerImage;
  /** Files picked together share a batch; the batch moves out of the upload list together. */
  batchId?: string;
}

/**
 * Where an entry is shown:
 *  uploading - left-hand upload list (checks, queue, transfer, transfer errors)
 *  verifying - "we're verifying the quality" grid (worker is processing)
 *  accepted  - Accepted Photos
 *  rejected  - "Didn't meet our guidelines" (validation failures + FAILED, which can be retried)
 */
export type Section = 'uploading' | 'verifying' | 'accepted' | 'rejected';

export function sectionOf(e: UploadEntry): Section {
  switch (e.phase) {
    case 'accepted':
      return 'accepted';
    case 'invalid':
    case 'rejected':
    case 'failed':
      return 'rejected';
    case 'processing':
      return 'verifying';
    default:
      return 'uploading';
  }
}

/** Still on its way to the server (a transfer error is not: it waits for the user to retry). */
export const isTransferring = (e: UploadEntry) => e.phase === 'validating' || e.phase === 'queued' || e.phase === 'uploading';

/**
 * Groups entries for display. Files picked together stay in the upload list until the whole
 * batch has reached the server ("Uploaded" rows), then move to the grid together, so a batch
 * reads as one upload instead of tiles trickling over one by one.
 */
export function groupEntries(entries: UploadEntry[]): Record<Section, UploadEntry[]> {
  const inFlight = new Set(entries.filter((e) => e.batchId && isTransferring(e)).map((e) => e.batchId));
  const g: Record<Section, UploadEntry[]> = { uploading: [], verifying: [], accepted: [], rejected: [] };
  for (const e of entries) {
    const held = e.server && e.batchId && inFlight.has(e.batchId);
    g[held ? 'uploading' : sectionOf(e)].push(e);
  }
  // entries are newest batch first, each batch in the order its files were picked, which is
  // already how the upload list should read: no reordering needed
  return g;
}
