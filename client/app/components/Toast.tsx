import { CheckCircleIcon } from './icons';

export function Toast({ title, detail, onClose }: { title: string; detail?: string; onClose: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-lg"
    >
      <CheckCircleIcon className="h-5 w-5 shrink-0 text-emerald-500" />
      <div className="text-sm">
        <p className="font-medium text-slate-900">{title}</p>
        {detail && <p className="mt-0.5 text-slate-500">{detail}</p>}
      </div>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="text-lg leading-none text-slate-400 hover:text-slate-600">
        ×
      </button>
    </div>
  );
}
