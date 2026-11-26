import { EyeIcon } from 'lucide-react';

/** True on the static demo site (`npm run build:demo`). */
export const IS_DEMO = import.meta.env.VITE_DEMO === 'true';

/** Strip above the top bar on the demo site: read-only, simulated data, where to get the real thing. */
export function DemoBanner() {
  if (!IS_DEMO) return null;
  return (
    <div role="note" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-primary/20 bg-primary/10 px-4 py-1.5 text-center text-[13px]">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <EyeIcon className="size-3.5" aria-hidden />
        Read-only demo
      </span>
      <span className="text-muted-foreground">Simulated company, agents and traffic. Changes aren't saved.</span>
      <span className="inline-flex gap-3">
        <a className="font-medium underline-offset-4 hover:underline" href="https://hub.neurouter.com/docs/quickstart">
          Run it yourself
        </a>
        <a className="font-medium underline-offset-4 hover:underline" href="https://github.com/neurouter/hub">
          GitHub
        </a>
      </span>
    </div>
  );
}

/** Compact label for the sticky top bar, so "read-only" stays visible after scrolling. */
export function DemoPill() {
  if (!IS_DEMO) return null;
  return (
    <span title="This is a read-only demo with simulated data" className="inline-flex h-[22px] items-center rounded-full border border-primary/40 bg-primary/10 px-2 text-xs font-medium text-primary">
      Demo · read-only
    </span>
  );
}
