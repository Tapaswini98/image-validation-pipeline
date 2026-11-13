import { describe, expect, it } from 'vitest';
import { initialUploadsState, uploadsReducer, type UploadsState } from './uploads-reducer';
import { groupEntries, sectionOf, type ServerImage, type UploadEntry } from '../lib/types';

const entry = (localId: string, over: Partial<UploadEntry> = {}): UploadEntry => ({
  localId,
  filename: `${localId}.jpg`,
  sizeBytes: 50_000,
  phase: 'validating',
  progress: 0,
  ...over,
});

const server = (id: string, status: ServerImage['status'], reason: string | null = null): ServerImage => ({
  id,
  collectionId: 'c',
  filename: `${id}.jpg`,
  status,
  rejectionCode: reason ? 'BLURRY' : null,
  rejectionReason: reason,
  mimeType: 'image/jpeg',
  sizeBytes: 50_000,
  width: 1000,
  height: 1000,
  metrics: { blurScore: null, faceCount: null, faceAreaRatio: null },
  url: null,
  thumbnailUrl: null,
  createdAt: new Date().toISOString(),
  processedAt: null,
});

const run = (state: UploadsState, ...actions: Parameters<typeof uploadsReducer>[1][]) => actions.reduce(uploadsReducer, state);
const phaseOf = (s: UploadsState, id: string) => s.entries.find((e) => e.localId === id)?.phase;

describe('uploadsReducer', () => {
  it('walks the happy path: validating -> queued -> uploading -> processing -> accepted', () => {
    let s = run(initialUploadsState, { type: 'ADD', entries: [entry('a')] });
    s = run(s, { type: 'VALIDATED', localId: 'a', reason: null });
    expect(phaseOf(s, 'a')).toBe('queued');
    s = run(s, { type: 'UPLOAD_STARTED', localId: 'a' }, { type: 'UPLOAD_PROGRESS', localId: 'a', progress: 0.5 });
    expect(s.entries[0]).toMatchObject({ phase: 'uploading', progress: 0.5 });
    s = run(s, { type: 'UPLOADED', localId: 'a', image: server('srv-a', 'PENDING') });
    expect(phaseOf(s, 'a')).toBe('processing');
    s = run(s, { type: 'SERVER_SYNC', images: [server('srv-a', 'ACCEPTED')] });
    expect(phaseOf(s, 'a')).toBe('accepted');
    expect(sectionOf(s.entries[0])).toBe('accepted');
  });

  it('client-side rejection never uploads and lands in Rejected with its reason and code', () => {
    const s = run(
      initialUploadsState,
      { type: 'ADD', entries: [entry('a')] },
      { type: 'VALIDATED', localId: 'a', reason: 'Unsupported format.', code: 'UNSUPPORTED_FORMAT' },
    );
    expect(s.entries[0]).toMatchObject({ phase: 'invalid', reason: 'Unsupported format.', reasonCode: 'UNSUPPORTED_FORMAT' });
    expect(sectionOf(s.entries[0])).toBe('rejected');
  });

  it('groups processing photos under "verifying" and FAILED ones under rejected (retryable)', () => {
    const s = run(
      initialUploadsState,
      { type: 'ADD', entries: [entry('a', { phase: 'uploading' }), entry('b', { phase: 'uploading' })] },
      { type: 'UPLOADED', localId: 'a', image: server('srv-a', 'PENDING') },
      { type: 'UPLOADED', localId: 'b', image: server('srv-b', 'FAILED') },
    );
    expect(sectionOf(s.entries.find((e) => e.localId === 'a')!)).toBe('verifying');
    expect(s.entries.find((e) => e.localId === 'b')).toMatchObject({ phase: 'failed', reasonCode: 'FAILED' });
    expect(sectionOf(s.entries.find((e) => e.localId === 'b')!)).toBe('rejected');
  });

  it('counts a settled batch once everything is checked (drives the toast), not before', () => {
    let s = run(initialUploadsState, { type: 'ADD', entries: [entry('a'), entry('b')] });
    s = run(s, { type: 'VALIDATED', localId: 'a', reason: 'bad', code: 'FILE_TOO_SMALL' });
    expect(s.batchesSettled).toBe(0); // b still validating
    s = run(s, { type: 'VALIDATED', localId: 'b', reason: null }, { type: 'UPLOAD_STARTED', localId: 'b' });
    s = run(s, { type: 'UPLOADED', localId: 'b', image: server('srv-b', 'PENDING') });
    expect(s.batchesSettled).toBe(0); // verifying
    s = run(s, { type: 'SERVER_SYNC', images: [server('srv-b', 'ACCEPTED')] });
    expect(s.batchesSettled).toBe(1);
    s = run(s, { type: 'SERVER_SYNC', images: [server('srv-b', 'ACCEPTED')] });
    expect(s.batchesSettled).toBe(1); // idempotent re-sync doesn't re-trigger
  });

  it('server rejection carries the reason through', () => {
    const s = run(
      initialUploadsState,
      { type: 'ADD', entries: [entry('a', { phase: 'uploading' })] },
      { type: 'UPLOADED', localId: 'a', image: server('srv-a', 'PENDING') },
      { type: 'SERVER_SYNC', images: [server('srv-a', 'REJECTED', 'Photo is too blurry')] },
    );
    expect(s.entries[0]).toMatchObject({ phase: 'rejected', reason: 'Photo is too blurry' });
  });

  it('upload errors are retryable: upload-error -> queued', () => {
    let s = run(
      initialUploadsState,
      { type: 'ADD', entries: [entry('a', { phase: 'uploading' })] },
      { type: 'UPLOAD_FAILED', localId: 'a', reason: 'Network error' },
    );
    expect(phaseOf(s, 'a')).toBe('upload-error');
    expect(sectionOf(s.entries[0])).toBe('uploading'); // stays in the upload list with a Retry button
    s = run(s, { type: 'RETRY_UPLOAD', localId: 'a' });
    expect(s.entries[0]).toMatchObject({ phase: 'queued', reason: undefined });
  });

  it('ignores a late VALIDATED for an entry that already moved on', () => {
    const s = run(initialUploadsState, { type: 'ADD', entries: [entry('a', { phase: 'uploading' })] }, { type: 'VALIDATED', localId: 'a', reason: 'x' });
    expect(phaseOf(s, 'a')).toBe('uploading');
  });

  it('history does not duplicate images already on screen', () => {
    const s = run(
      initialUploadsState,
      { type: 'ADD', entries: [entry('a', { phase: 'processing', server: server('srv-a', 'PENDING') })] },
      { type: 'HISTORY_LOADED', images: [server('srv-a', 'ACCEPTED'), server('srv-b', 'REJECTED', 'r')], nextCursor: 'next' },
    );
    expect(s.entries.map((e) => e.localId)).toEqual(['a', 'srv-b']);
    expect(s.nextCursor).toBe('next');
  });
});

describe('groupEntries (a batch moves out of the upload list together)', () => {
  const b = (id: string, phase: UploadEntry['phase'], batchId = 'b1') =>
    entry(id, { phase, batchId, server: phase === 'queued' || phase === 'uploading' ? undefined : server(id, 'PENDING') });

  it('keeps uploaded files in the upload list while a sibling is still uploading', () => {
    const g = groupEntries([b('a', 'processing'), b('b', 'uploading'), b('c', 'accepted')]);
    expect(g.uploading.map((e) => e.localId)).toEqual(['a', 'b', 'c']);
    expect(g.verifying).toHaveLength(0);
    expect(g.accepted).toHaveLength(0);
  });

  it('releases the whole batch once every file has reached the server', () => {
    const g = groupEntries([b('a', 'processing'), b('b', 'processing'), b('c', 'accepted')]);
    expect(g.uploading).toHaveLength(0);
    expect(g.verifying.map((e) => e.localId)).toEqual(['a', 'b']);
    expect(g.accepted.map((e) => e.localId)).toEqual(['c']);
  });

  it('does not hold an older batch, nor wait for a failed transfer', () => {
    const g = groupEntries([
      b('new', 'uploading', 'b2'),
      b('old', 'processing', 'b1'),
      b('err', 'upload-error', 'b3'),
      b('done', 'processing', 'b3'),
    ]);
    expect(g.verifying.map((e) => e.localId)).toEqual(['old', 'done']);
    expect(g.uploading.map((e) => e.localId)).toEqual(['new', 'err']);
  });

  it('a retried upload gets its own batch, so its uploaded siblings stay put', () => {
    let s: UploadsState = { ...initialUploadsState, entries: [b('err', 'upload-error'), b('ok', 'processing')] };
    s = uploadsReducer(s, { type: 'RETRY_UPLOAD', localId: 'err' });
    expect(groupEntries(s.entries).verifying.map((e) => e.localId)).toEqual(['ok']);
  });
});
