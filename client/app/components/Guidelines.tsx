import { LIMITS } from '../lib/config';
import { Collapsible } from './Collapsible';
import { BanIcon, CheckCircleIcon } from './icons';

const REQUIREMENTS = [
  'Photos of you, and only you',
  'Your face clearly visible and in focus',
  'Close-ups, selfies and mid-range shots (face large enough in the frame)',
  'Different backgrounds, outfits and lighting',
  `JPG, PNG or HEIC, at least ${LIMITS.minDimensionPx}px on the shortest side`,
];

const RESTRICTIONS = [
  'Group photos or other people in the frame',
  'Blurry or out-of-focus photos',
  'Photos taken from far away',
  'Near-duplicates of a photo you already uploaded',
  'Screenshots, tiny thumbnails or other file types (GIF, WebP)',
];

export function Guidelines({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <div className="space-y-4">
      <Collapsible title="Photo Requirements" tone="green" defaultOpen={defaultOpen} icon={<CheckCircleIcon className="h-5 w-5 text-emerald-500" />}>
        <List items={REQUIREMENTS} icon={<CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-500" />} />
      </Collapsible>
      <Collapsible title="Photo Restrictions" tone="red" defaultOpen={defaultOpen} icon={<BanIcon className="h-5 w-5 text-red-500" />}>
        <List items={RESTRICTIONS} icon={<BanIcon className="h-4 w-4 shrink-0 text-red-500" />} />
      </Collapsible>
    </div>
  );
}

function List({ items, icon }: { items: string[]; icon: React.ReactNode }) {
  return (
    <ul className="space-y-2 text-sm text-slate-700">
      {items.map((t) => (
        <li key={t} className="flex items-start gap-2">
          <span className="mt-0.5">{icon}</span>
          {t}
        </li>
      ))}
    </ul>
  );
}
