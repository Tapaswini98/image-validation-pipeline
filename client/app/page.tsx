'use client';
import { Collapsible } from './components/Collapsible';
import { Guidelines } from './components/Guidelines';
import { PhotoTile } from './components/PhotoTile';
import { ProgressHeader } from './components/ProgressHeader';
import { Toast } from './components/Toast';
import { UploadPanel } from './components/UploadPanel';
import { PHOTO_GOAL } from './lib/config';
import type { UploadEntry } from './lib/types';
import { useUploads } from './state/useUploads';

const GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4';

export default function UploadPage() {
  const u = useUploads();
  const { uploading, verifying, accepted, rejected } = u.groups;
  const hasPhotos = verifying.length + accepted.length + rejected.length > 0;
  const session = (list: UploadEntry[]) => list.filter((e) => e.file).length;
  const incoming = uploading.filter((e) => e.phase !== 'upload-error').length;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <span className="text-base font-bold text-slate-900">Photo upload</span>
          {(hasPhotos || uploading.length > 0) && (
            <button type="button" onClick={u.newCollection} className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
              Start a new set
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 md:grid-cols-[260px_1fr] lg:grid-cols-[300px_1fr]">
        <aside className="md:sticky md:top-20 md:self-start">
          <UploadPanel onFiles={u.addFiles} uploading={uploading} onRetry={u.retry} onRemove={u.remove} />
        </aside>

        <div className="min-w-0 space-y-6 md:border-l md:border-slate-200 md:pl-8">
          <ProgressHeader accepted={accepted.length} />

          {u.notice && (
            <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {u.notice}
              <button type="button" onClick={u.dismissNotice} aria-label="Dismiss" className="text-amber-600 hover:text-amber-900">
                ×
              </button>
            </div>
          )}

          {verifying.length + incoming > 0 && (
            <section aria-label="Verifying" className="rounded-2xl border border-slate-200 bg-white p-5">
              <p className="mb-4 text-sm text-slate-700">
                {verifying.length > 0
                  ? "You're almost there! We're just verifying the quality of your uploads to make sure you get the best results."
                  : 'Uploading your photos…'}
              </p>
              <div className={GRID}>
                {verifying.map((e) => (
                  <PhotoTile key={e.localId} entry={e} variant="verifying" />
                ))}
                {/* placeholders for the batch still uploading on the left */}
                {Array.from({ length: incoming }, (_, i) => (
                  <div key={`skeleton-${i}`} aria-hidden className="aspect-[3/4] animate-pulse rounded-xl bg-slate-100" />
                ))}
              </div>
            </section>
          )}

          {accepted.length > 0 && (
            <div aria-label="Accepted">
              <Collapsible
                title="Accepted Photos"
                tone="green"
                subtitle="These photos passed our quality checks and will all be used to generate your AI photos."
              >
                <div className={GRID}>
                  {accepted.map((e) => (
                    <PhotoTile key={e.localId} entry={e} variant="accepted" onRemove={u.remove} />
                  ))}
                </div>
              </Collapsible>
            </div>
          )}

          {rejected.length > 0 && (
            <div aria-label="Rejected">
              <Collapsible
                title="Some Photos Didn't Meet Our Guidelines"
                tone="red"
                subtitle={
                  accepted.length >= PHOTO_GOAL.min
                    ? `You can move to the next step as you've uploaded ${accepted.length} good photos. Replacing these is optional.`
                    : 'Hover a reason to see how to fix it, then upload a replacement.'
                }
              >
                <div className={GRID}>
                  {rejected.map((e) => (
                    <PhotoTile key={e.localId} entry={e} variant="rejected" onRemove={u.remove} onRetry={u.retry} />
                  ))}
                </div>
              </Collapsible>
            </div>
          )}

          {u.hasMore && (
            <div className="text-center">
              <button
                type="button"
                onClick={u.loadMore}
                disabled={u.loadingMore}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {u.loadingMore ? 'Loading…' : 'Load older photos'}
              </button>
            </div>
          )}

          <Guidelines defaultOpen={!hasPhotos} />
        </div>
      </main>

      {u.toast && (
        <Toast
          title="Your photos have been uploaded and checked!"
          detail={`${session(accepted)} accepted · ${session(rejected)} need attention`}
          onClose={u.dismissToast}
        />
      )}
    </div>
  );
}
