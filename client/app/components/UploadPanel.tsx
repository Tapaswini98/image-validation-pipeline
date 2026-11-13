'use client';
import { useRef, useState } from 'react';
import { LIMITS, PHOTO_GOAL } from '../lib/config';
import type { UploadEntry } from '../lib/types';
import { CheckCircleIcon, PhotoIcon, Spinner, UploadIcon, XCircleIcon } from './icons';

interface Props {
  onFiles: (files: FileList) => void;
  uploading: UploadEntry[];
  onRetry: (e: UploadEntry) => void;
  onRemove: (e: UploadEntry) => void;
}

/** Left column: instructions, drop zone and the list of files currently being checked/uploaded. */
export function UploadPanel({ onFiles, uploading, onRetry, onRemove }: Props) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const transferring = uploading.some((e) => e.phase !== 'upload-error');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Upload photos</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          Select at least <b className="text-slate-700">{PHOTO_GOAL.min} of your best photos</b>. A{' '}
          <b className="text-slate-700">mix of close-ups, selfies and mid-range shots</b> helps the AI capture your
          face.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed px-5 py-8 text-center transition-colors ${
          dragging ? 'border-orange-400 bg-orange-50' : 'border-slate-300 bg-white'
        }`}
      >
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={`inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition ${
            transferring ? 'bg-orange-300' : 'bg-orange-500 hover:bg-orange-600'
          } focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2`}
        >
          {transferring ? <Spinner className="h-4 w-4 text-white" /> : <UploadIcon />}
          {transferring ? 'Uploading…' : 'Upload files'}
        </button>
        <p className="mt-4 text-sm font-medium text-slate-800">Click to upload or drag and drop</p>
        <p className="text-xs text-slate-500">PNG, JPG, HEIC up to {LIMITS.maxFileBytes / (1024 * 1024)}MB</p>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png"
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
      </div>

      {uploading.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-slate-500">It can take up to 1 minute to upload</p>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white" aria-live="polite">
            {uploading.map((e) => (
              <UploadRow key={e.localId} entry={e} onRetry={onRetry} onRemove={onRemove} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UploadRow({ entry, onRetry, onRemove }: { entry: UploadEntry } & Pick<Props, 'onRetry' | 'onRemove'>) {
  const failed = entry.phase === 'upload-error';
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500">
        <PhotoIcon />
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-all text-xs font-medium text-slate-800">{entry.filename}</p>
        {entry.phase === 'uploading' && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-orange-400 transition-[width]" style={{ width: `${entry.progress * 100}%` }} />
          </div>
        )}
        {failed && <p className="mt-0.5 text-[11px] text-red-600">{entry.reason}</p>}
      </div>
      {failed ? (
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => onRetry(entry)} className="rounded-md bg-orange-100 px-2 py-1 text-[11px] font-semibold text-orange-800 hover:bg-orange-200">
            Retry
          </button>
          <button type="button" onClick={() => onRemove(entry)} aria-label={`Remove ${entry.filename}`} className="text-slate-400 hover:text-slate-600">
            <XCircleIcon />
          </button>
        </div>
      ) : entry.server ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600">
          <CheckCircleIcon className="h-4 w-4" />
          Uploaded
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500" title={entry.phase}>
          {entry.phase === 'uploading' && `${Math.round(entry.progress * 100)}%`}
          <Spinner />
        </span>
      )}
    </li>
  );
}
