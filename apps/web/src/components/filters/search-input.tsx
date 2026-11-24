import { useEffect, useState } from 'react';
import { SearchIcon, XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { cn } from '@/lib/utils';

/**
 * Debounced search box that writes to the URL (`?q`) via `onChange` after `delayMs`.
 * Local state keeps typing instant; external changes (back/forward, reset) resync it.
 */
export function SearchInput({ value, onChange, label, placeholder, delayMs = 300, className }: { value: string | undefined; onChange: (q: string | undefined) => void; label: string; placeholder?: string; delayMs?: number; className?: string }) {
  const [text, setText] = useState(value ?? '');
  // resync when the URL value changes from outside (back/forward, reset): adjust state during render
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    if ((text.trim() || undefined) !== (value || undefined)) setText(value ?? '');
  }
  const debounced = useDebouncedValue(text, delayMs);
  useEffect(() => {
    const next = debounced.trim() || undefined;
    if (next !== (value || undefined)) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return (
    <label className={cn('relative flex min-w-48 flex-1 items-center sm:max-w-sm', className)}>
      <span className="sr-only">{label}</span>
      <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
      <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder ?? label} className="h-9 pl-8" />
      {text ? (
        <button type="button" aria-label="Clear search" className="absolute right-2 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setText('')}>
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </label>
  );
}
