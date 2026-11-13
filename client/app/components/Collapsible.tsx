'use client';
import { useId, useState, type ReactNode } from 'react';
import { ChevronIcon } from './icons';

const TONES = {
  neutral: 'bg-white border-slate-200',
  green: 'bg-emerald-50/50 border-emerald-100',
  red: 'bg-red-50/40 border-red-100',
};

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  tone?: keyof typeof TONES;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Collapsible({ title, subtitle, icon, tone = 'neutral', defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={`rounded-2xl border ${TONES[tone]}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-start justify-between gap-4 rounded-2xl px-5 py-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      >
        <span>
          <span className="flex items-center gap-2 text-base font-semibold text-slate-900">
            {icon}
            {title}
          </span>
          {subtitle && <span className="mt-0.5 block text-sm text-slate-500">{subtitle}</span>}
        </span>
        <ChevronIcon className={`mt-1 h-5 w-5 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={id} className="px-5 pb-5">
          {children}
        </div>
      )}
    </section>
  );
}
