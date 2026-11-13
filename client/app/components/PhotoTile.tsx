'use client';
import { useState } from 'react';
import { rejectionCopy } from '../lib/rejection-copy';
import type { UploadEntry } from '../lib/types';
import { PhotoIcon, Spinner, TrashIcon, XCircleIcon } from './icons';

interface Props {
  entry: UploadEntry;
  variant: 'accepted' | 'rejected' | 'verifying';
  onRemove?: (e: UploadEntry) => void;
  onRetry?: (e: UploadEntry) => void;
}

export function PhotoTile({ entry, variant, onRemove, onRetry }: Props) {
  // A file named .jpg that isn't really an image (or an expired URL) fails to render:
  // remember which src failed and show the placeholder instead of a broken-image icon.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const candidate = entry.previewUrl ?? entry.server?.thumbnailUrl ?? undefined;
  const src = candidate && candidate !== failedSrc ? candidate : undefined;
  const copy = variant === 'rejected' ? rejectionCopy(entry.reasonCode, entry.reason) : null;

  return (
    <figure className="min-w-0">
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-slate-100 shadow-sm">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob: and presigned URLs, nothing to optimise
          <img
            src={src}
            alt={entry.filename}
            title={entry.filename}
            onError={() => setFailedSrc(src)}
            className={`h-full w-full object-cover ${variant === 'verifying' ? 'scale-105 blur-md' : ''}`}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-slate-400">
            <PhotoIcon className="h-7 w-7" />
            <span className="px-2 text-center text-[11px]">No preview</span>
          </div>
        )}

        {variant === 'verifying' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/20">
            <Spinner className="h-6 w-6 text-white" />
          </div>
        )}

        {variant !== 'verifying' && onRemove && (
          <button
            type="button"
            onClick={() => onRemove(entry)}
            aria-label={`Delete ${entry.filename}`}
            className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-slate-600 shadow hover:bg-white hover:text-red-600"
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {copy && (
        <figcaption className="mt-2 text-center">
          {/* Label with a hover/focus tooltip that explains how to fix it */}
          <span className="group relative inline-block">
            <button
              type="button"
              className="text-xs text-slate-700 underline decoration-dotted underline-offset-4 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              {copy.label}
            </button>
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-56 -translate-x-1/2 rounded-lg bg-slate-900 p-3 text-left text-xs text-slate-100 shadow-lg group-hover:block group-focus-within:block"
            >
              <span className="mb-1 flex items-center gap-1.5 font-semibold text-white">
                <XCircleIcon className="h-4 w-4 text-red-400" />
                Try again
              </span>
              {copy.tip}
            </span>
          </span>
          {entry.phase === 'failed' && onRetry && (
            <button
              type="button"
              onClick={() => onRetry(entry)}
              className="mt-1 block w-full rounded-md bg-orange-100 px-2 py-1 text-[11px] font-semibold text-orange-800 hover:bg-orange-200"
            >
              Retry
            </button>
          )}
        </figcaption>
      )}
    </figure>
  );
}
