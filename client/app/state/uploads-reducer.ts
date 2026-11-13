import { sectionOf, type EntryPhase, type ServerImage, type ServerStatus, type UploadEntry } from '../lib/types';

/**
 * All upload state transitions in one pure reducer: easy to reason about, easy to test,
 * and impossible to end up in a half-updated state from interleaved async callbacks.
 */
export interface UploadsState {
  entries: UploadEntry[]; // newest first
  nextCursor: string | null;
  notice: string | null;
  /** Incremented each time the page goes from "work in flight" to "all settled" (drives the toast). */
  batchesSettled: number;
}

export const initialUploadsState: UploadsState = { entries: [], nextCursor: null, notice: null, batchesSettled: 0 };

/** Anything still being checked, uploaded or verified (transfer errors count: they await a retry). */
export const isBusy = (entries: UploadEntry[]) =>
  entries.some((e) => sectionOf(e) === 'uploading' || sectionOf(e) === 'verifying');

export function uploadsReducer(state: UploadsState, action: UploadsAction): UploadsState {
  const next = reduce(state, action);
  if (action.type !== 'RESET' && isBusy(state.entries) && !isBusy(next.entries)) {
    return { ...next, batchesSettled: state.batchesSettled + 1 };
  }
  return next;
}

export type UploadsAction =
  | { type: 'ADD'; entries: UploadEntry[] }
  | { type: 'VALIDATED'; localId: string; reason: string | null; code?: string }
  | { type: 'PREVIEW_READY'; localId: string; previewUrl: string }
  | { type: 'UPLOAD_STARTED'; localId: string }
  | { type: 'UPLOAD_PROGRESS'; localId: string; progress: number }
  | { type: 'UPLOADED'; localId: string; image: ServerImage }
  | { type: 'UPLOAD_FAILED'; localId: string; reason: string }
  | { type: 'RETRY_UPLOAD'; localId: string }
  | { type: 'SERVER_SYNC'; images: ServerImage[] }
  | { type: 'HISTORY_LOADED'; images: ServerImage[]; nextCursor: string | null }
  | { type: 'REMOVE'; localId: string }
  | { type: 'RESET' }
  | { type: 'NOTICE'; message: string | null };

const PHASE_BY_STATUS: Record<ServerStatus, EntryPhase> = {
  PENDING: 'processing',
  PROCESSING: 'processing',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  FAILED: 'failed',
};

function withServer(e: UploadEntry, image: ServerImage): UploadEntry {
  return {
    ...e,
    server: image,
    phase: PHASE_BY_STATUS[image.status],
    reason: image.rejectionReason ?? undefined,
    reasonCode: image.status === 'FAILED' ? 'FAILED' : (image.rejectionCode ?? undefined),
    progress: 1,
  };
}

function update(state: UploadsState, localId: string, fn: (e: UploadEntry) => UploadEntry): UploadsState {
  return { ...state, entries: state.entries.map((e) => (e.localId === localId ? fn(e) : e)) };
}

export function fromServer(image: ServerImage): UploadEntry {
  return withServer({ localId: image.id, filename: image.filename, sizeBytes: image.sizeBytes, phase: 'processing', progress: 1 }, image);
}

function reduce(state: UploadsState, action: UploadsAction): UploadsState {
  switch (action.type) {
    case 'ADD':
      return { ...state, entries: [...action.entries, ...state.entries] };

    case 'VALIDATED':
      return update(state, action.localId, (e) =>
        e.phase !== 'validating'
          ? e
          : action.reason
            ? { ...e, phase: 'invalid', reason: action.reason, reasonCode: action.code }
            : { ...e, phase: 'queued' },
      );

    case 'PREVIEW_READY':
      return update(state, action.localId, (e) => ({ ...e, previewUrl: action.previewUrl }));

    case 'UPLOAD_STARTED':
      return update(state, action.localId, (e) => ({ ...e, phase: 'uploading', progress: 0, reason: undefined }));

    case 'UPLOAD_PROGRESS':
      return update(state, action.localId, (e) => (e.phase === 'uploading' ? { ...e, progress: action.progress } : e));

    case 'UPLOADED':
      return update(state, action.localId, (e) => withServer(e, action.image));

    case 'UPLOAD_FAILED':
      return update(state, action.localId, (e) => ({ ...e, phase: 'upload-error', reason: action.reason }));

    case 'RETRY_UPLOAD':
      // A retry gets its own batch, so its already-uploaded siblings aren't pulled back into the upload list.
      return update(state, action.localId, (e) =>
        e.phase === 'upload-error' ? { ...e, phase: 'queued', reason: undefined, batchId: `retry-${e.localId}` } : e,
      );

    case 'SERVER_SYNC': {
      const byId = new Map(action.images.map((i) => [i.id, i]));
      return {
        ...state,
        entries: state.entries.map((e) => {
          const image = e.server && byId.get(e.server.id);
          return image ? withServer(e, image) : e;
        }),
      };
    }

    case 'HISTORY_LOADED': {
      const known = new Set(state.entries.map((e) => e.server?.id).filter(Boolean));
      const older = action.images.filter((i) => !known.has(i.id)).map(fromServer);
      return { ...state, entries: [...state.entries, ...older], nextCursor: action.nextCursor };
    }

    case 'REMOVE':
      return { ...state, entries: state.entries.filter((e) => e.localId !== action.localId) };

    case 'RESET':
      return initialUploadsState;

    case 'NOTICE':
      return { ...state, notice: action.message };
  }
}
