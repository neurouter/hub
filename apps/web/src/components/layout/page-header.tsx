import { useEffect, useRef, type ReactNode } from 'react';

/** h1 + description + actions. Sets document.title and takes focus on route change (a11y §8). */
export function PageHeader({ title, description, actions, leading }: { title: string; description?: ReactNode; actions?: ReactNode; leading?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · Neurouter`;
    ref.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {leading}
        <div className="flex min-w-0 flex-col gap-1">
          <h1 ref={ref} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
            {title}
          </h1>
          {description ? <p className="text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
