import { cn } from '@/lib/utils';

/**
 * Segmented control (prototype `.tabs role=radiogroup`): one choice from a few options.
 * Keyboard: arrow keys move the selection (roving tabindex).
 */
export function Segmented<V extends string>({ value, onChange, options, label, size = 'default', className }: { value: V; onChange: (v: V) => void; options: readonly { value: V; label: string }[]; label: string; size?: 'default' | 'sm'; className?: string }) {
  function onKey(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = options[(i + dir + options.length) % options.length];
    if (next) {
      onChange(next.value);
      const sib = (e.currentTarget.parentElement?.children[(i + dir + options.length) % options.length] as HTMLElement | undefined);
      sib?.focus();
    }
  }
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex w-fit items-center rounded-lg bg-muted p-[3px] text-muted-foreground', size === 'sm' ? 'h-8' : 'h-9', className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-full items-center rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              on ? 'bg-background text-foreground shadow-sm dark:bg-input/40' : 'hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
