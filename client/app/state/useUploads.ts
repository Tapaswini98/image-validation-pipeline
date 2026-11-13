'use client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, deleteImage, listImages, retryImage, uploadImage } from '../lib/api';
import { getCollectionId, startNewCollection } from '../lib/collection';
import { LIMITS } from '../lib/config';
import { checkFile, previewUrlFor } from '../lib/file-checks';
import { groupEntries, type UploadEntry } from '../lib/types';
import { initialUploadsState, uploadsReducer } from './uploads-reducer';

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

/**
 * Orchestrates the upload lifecycle on top of the pure reducer:
 *  - client checks + previews run immediately on drop
 *  - a scheduler uploads queued files, at most LIMITS.uploadConcurrency at a time
 *  - one batched poll (GET /images?ids=...) tracks every file the worker is processing
 */
export function useUploads() {
  // localStorage only exists in the browser; the id is never rendered, so SSR/hydration can't mismatch.
  const [collectionId, setCollectionId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : getCollectionId(),
  );
  const [state, dispatch] = useReducer(uploadsReducer, initialUploadsState);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dismissedBatch, setDismissedBatch] = useState(0);
  const started = useRef(new Set<string>()); // guards against double-starting an upload
  const entriesRef = useRef<UploadEntry[]>([]);

  useEffect(() => {
    entriesRef.current = state.entries;
  }, [state.entries]);

  // Load this collection's existing images (persisted on the server).
  useEffect(() => {
    if (!collectionId) return;
    let cancelled = false;
    listImages({ collectionId, limit: 24 })
      .then((page) => !cancelled && dispatch({ type: 'HISTORY_LOADED', images: page.items, nextCursor: page.nextCursor }))
      .catch(() => !cancelled && dispatch({ type: 'NOTICE', message: 'Cannot reach the server. Is the API running?' }));
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  // Revoke object URLs when the page unmounts.
  useEffect(
    () => () => entriesRef.current.forEach((e) => e.previewUrl?.startsWith('blob:') && URL.revokeObjectURL(e.previewUrl)),
    [],
  );

  const addFiles = useCallback((input: FileList | File[]) => {
    const existing = new Set(entriesRef.current.flatMap((e) => (e.file ? [fileKey(e.file)] : [])));
    const all = Array.from(input);
    const fresh = all.filter((f) => !existing.has(fileKey(f))).slice(0, LIMITS.maxFilesPerDrop);
    const skipped = all.length - fresh.length;
    dispatch({
      type: 'NOTICE',
      message: skipped > 0 ? `Skipped ${skipped} file(s): already added, or more than ${LIMITS.maxFilesPerDrop} at once.` : null,
    });
    if (fresh.length === 0) return;

    const batchId = crypto.randomUUID();
    const entries: UploadEntry[] = fresh.map((file) => ({
      batchId,
      localId: crypto.randomUUID(),
      file,
      filename: file.name,
      sizeBytes: file.size,
      phase: 'validating',
      progress: 0,
    }));
    dispatch({ type: 'ADD', entries });

    for (const e of entries) {
      void checkFile(e.file!).then((r) =>
        dispatch({ type: 'VALIDATED', localId: e.localId, reason: r?.reason ?? null, code: r?.code }),
      );
      void previewUrlFor(e.file!).then((url) => url && dispatch({ type: 'PREVIEW_READY', localId: e.localId, previewUrl: url }));
    }
  }, []);

  // Upload scheduler: fills free slots with the oldest queued files.
  useEffect(() => {
    if (!collectionId) return;
    const active = state.entries.filter((e) => e.phase === 'uploading').length;
    const slots = LIMITS.uploadConcurrency - active;
    if (slots <= 0) return;
    const queued = state.entries.filter((e) => e.phase === 'queued' && e.file && !started.current.has(e.localId));
    // entries are newest batch first: take the oldest batch first, files in the order they were picked
    const batches = [...new Set(queued.map((e) => e.batchId))].reverse();
    const next = batches.flatMap((b) => queued.filter((e) => e.batchId === b)).slice(0, slots);

    for (const e of next) {
      started.current.add(e.localId);
      dispatch({ type: 'UPLOAD_STARTED', localId: e.localId });
      let last = 0;
      uploadImage(e.file!, collectionId, (p) => {
        if (p - last >= 0.05 || p === 1) {
          last = p; // throttle re-renders
          dispatch({ type: 'UPLOAD_PROGRESS', localId: e.localId, progress: p });
        }
      })
        .then((image) => dispatch({ type: 'UPLOADED', localId: e.localId, image }))
        .catch((err: Error) => {
          started.current.delete(e.localId);
          dispatch({ type: 'UPLOAD_FAILED', localId: e.localId, reason: err.message });
        });
    }
  }, [state.entries, collectionId]);

  // Poll the server for everything still processing, in ONE request.
  const processingIds = state.entries
    .filter((e) => e.phase === 'processing' && e.server)
    .map((e) => e.server!.id)
    .slice(0, 100)
    .join(',');

  useEffect(() => {
    if (!collectionId || !processingIds) return;
    const ids = processingIds.split(',');
    const timer = setInterval(() => {
      listImages({ collectionId, ids })
        .then((page) => dispatch({ type: 'SERVER_SYNC', images: page.items }))
        .catch(() => undefined); // transient: next tick retries
    }, LIMITS.pollIntervalMs);
    return () => clearInterval(timer);
  }, [processingIds, collectionId]);

  const retry = useCallback(async (entry: UploadEntry) => {
    if (entry.phase === 'upload-error') return dispatch({ type: 'RETRY_UPLOAD', localId: entry.localId });
    if (entry.phase === 'failed' && entry.server) {
      try {
        const image = await retryImage(entry.server.id);
        dispatch({ type: 'SERVER_SYNC', images: [image] });
      } catch (err) {
        dispatch({ type: 'NOTICE', message: `Retry failed: ${(err as Error).message}` });
      }
    }
  }, []);

  const remove = useCallback(async (entry: UploadEntry) => {
    if (entry.server) {
      try {
        await deleteImage(entry.server.id);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) {
          return dispatch({ type: 'NOTICE', message: `Could not delete: ${(err as Error).message}` });
        }
      }
    }
    if (entry.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(entry.previewUrl);
    dispatch({ type: 'REMOVE', localId: entry.localId });
  }, []);

  const loadMore = useCallback(async () => {
    if (!collectionId || !state.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listImages({ collectionId, cursor: state.nextCursor, limit: 24 });
      dispatch({ type: 'HISTORY_LOADED', images: page.items, nextCursor: page.nextCursor });
    } finally {
      setLoadingMore(false);
    }
  }, [collectionId, state.nextCursor]);

  const newCollection = useCallback(() => {
    entriesRef.current.forEach((e) => e.previewUrl?.startsWith('blob:') && URL.revokeObjectURL(e.previewUrl));
    started.current.clear();
    setDismissedBatch(0);
    dispatch({ type: 'RESET' });
    setCollectionId(startNewCollection());
  }, []);

  const groups = useMemo(() => groupEntries(state.entries), [state.entries]);

  // Toast after each batch settles; auto-hides. Derived from the reducer's counter, so no
  // setState-in-effect: the effect only schedules the dismissal.
  const showToast = state.batchesSettled > dismissedBatch;
  useEffect(() => {
    if (!showToast) return;
    const t = setTimeout(() => setDismissedBatch(state.batchesSettled), 6000);
    return () => clearTimeout(t);
  }, [showToast, state.batchesSettled]);

  return {
    collectionId,
    groups,
    busy: groups.uploading.length + groups.verifying.length > 0,
    toast: showToast,
    dismissToast: () => setDismissedBatch(state.batchesSettled),
    notice: state.notice,
    hasMore: Boolean(state.nextCursor),
    loadingMore,
    addFiles,
    retry,
    remove,
    loadMore,
    newCollection,
    dismissNotice: () => dispatch({ type: 'NOTICE', message: null }),
  };
}
