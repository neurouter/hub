import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Page body wrapper: consistent vertical rhythm and max widths (§8 responsive table). */
export function Page({ children, width = 'wide', className }: { children: ReactNode; width?: 'wide' | 'form'; className?: string }) {
  return <div className={cn('flex w-full flex-col gap-5', width === 'form' ? 'max-w-3xl' : 'max-w-screen-2xl', className)}>{children}</div>;
}

/** Bordered card section with a title row (prototype `.card` + h2). */
export function Section({ title, description, actions, children, className, id, bodyClassName }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; bodyClassName?: string }) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col rounded-xl border bg-card', className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title ? (
              <h2 id={headingId} className="text-[15px] font-semibold">
                {title}
              </h2>
            ) : null}
            {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Key/value grid (prototype `.kv`). */
export function DetailList({ items, className }: { items: { label: ReactNode; value: ReactNode; key?: string }[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-[13.5px]', className)}>
      {items.map((it, i) => (
        <div key={it.key ?? i} className="contents">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className="min-w-0 break-words">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Toolbar row above tables (wraps on small screens). */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}
