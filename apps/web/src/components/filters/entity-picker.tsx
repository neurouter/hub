import { useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { cn } from '@/lib/utils';

export interface PickerOption {
  id: string;
  name: string;
  hint?: string;
}

/**
 * Server-searched single-select picker (frontend §5.3 filter comboboxes, grant subject/target).
 * `search(q)` is called through TanStack Query, keyed by `queryKey` + the debounced text.
 */
export function EntityPicker({
  label, value, onChange, search, queryKey, placeholder, chip = false, disabled, className, icon, allowClear = true,
}: {
  label: string;
  value: PickerOption | null | undefined;
  onChange: (next: PickerOption | null) => void;
  search: (q: string, signal: AbortSignal) => Promise<PickerOption[]>;
  queryKey: readonly unknown[];
  placeholder?: string;
  /** Render as a filter chip ("Agent: name ×") instead of a select-like button. */
  chip?: boolean;
  disabled?: boolean;
  className?: string;
  icon?: ReactNode;
  allowClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const q = useDebouncedValue(text, 250);
  const listId = useId();
  const { data, isFetching } = useQuery({
    queryKey: [...queryKey, 'picker', q],
    queryFn: ({ signal }) => search(q, signal),
    enabled: open,
    staleTime: 30_000,
  });

  function pick(o: PickerOption | null) {
    onChange(o);
    setOpen(false);
    setText('');
  }

  const trigger = chip ? (
    <PopoverTrigger
      disabled={disabled}
      render={
        <button
          type="button"
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap hover:bg-muted',
            value ? 'border-foreground/40 bg-muted text-foreground' : 'border-dashed text-muted-foreground',
            className,
          )}
        />
      }
    >
      {icon}
      {value ? (
        <>
          {label}: <b className="font-medium">{value.name}</b>
        </>
      ) : (
        label
      )}
    </PopoverTrigger>
  ) : (
    <PopoverTrigger
      disabled={disabled}
      render={<Button variant="outline" className={cn('h-9 min-w-48 justify-between font-normal', !value && 'text-muted-foreground', className)} />}
      aria-label={value ? `${label}: ${value.name}` : label}
    >
      <span className="flex min-w-0 items-center gap-2 truncate">
        {icon}
        {value ? value.name : (placeholder ?? label)}
      </span>
      <ChevronDownIcon className="opacity-60" />
    </PopoverTrigger>
  );

  return (
    <span className="inline-flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        {trigger}
        <PopoverContent align="start" className="w-80 p-2">
          <Input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <ul id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
            {isFetching && !data ? (
              <li className="flex items-center gap-2 p-2 text-muted-foreground">
                <Spinner /> Searching…
              </li>
            ) : null}
            {data && data.length === 0 ? <li className="p-2 text-muted-foreground">No matches</li> : null}
            {data?.map((o) => (
              <li
                key={o.id}
                role="option"
                aria-selected={value?.id === o.id}
                tabIndex={0}
                onClick={() => pick(o)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick(o);
                  }
                }}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{o.name}</span>
                  {o.hint ? <span className="truncate text-xs text-muted-foreground">{o.hint}</span> : null}
                </span>
                {value?.id === o.id ? <CheckIcon className="size-4" /> : null}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      {value && allowClear && chip ? (
        <Button variant="ghost" size="icon-xs" className="-ml-7 rounded-full" aria-label={`Remove ${label.toLowerCase()} filter`} onClick={() => onChange(null)}>
          <XIcon />
        </Button>
      ) : null}
    </span>
  );
}
