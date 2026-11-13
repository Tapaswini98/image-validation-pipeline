import { PHOTO_GOAL } from '../lib/config';

/** "Uploaded Images: N of 10" with a marker at the minimum; turns green once the minimum is met. */
export function ProgressHeader({ accepted }: { accepted: number }) {
  const { min, target } = PHOTO_GOAL;
  const done = accepted >= min;
  const fill = Math.min(accepted / target, 1) * 100;
  const marker = (min / target) * 100;

  return (
    <div>
      <div className="relative flex items-end justify-between pb-2">
        <h2 className="text-sm font-semibold text-slate-900">Uploaded Images</h2>
        <span className="absolute -translate-x-1/2 text-center text-[11px] leading-none text-slate-500" style={{ left: `${marker}%`, bottom: 8 }}>
          {min}
          <span className="mx-auto mt-0.5 block h-1.5 w-px bg-slate-400" />
        </span>
        <span className="text-sm text-slate-500">
          <b className="text-slate-900">{accepted}</b> of <b className="text-slate-900">{target}</b>
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={accepted}
        aria-label={`${accepted} of ${target} photos accepted, minimum ${min}`}
      >
        <div className={`h-full rounded-full transition-all duration-500 ${done ? 'bg-emerald-500' : 'bg-orange-400'}`} style={{ width: `${fill}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-slate-500">
        {done
          ? `You have enough photos to continue. Adding up to ${target} improves results.`
          : `${min - accepted} more accepted photo${min - accepted === 1 ? '' : 's'} needed.`}
      </p>
    </div>
  );
}
