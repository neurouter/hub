import { useState } from 'react';
import { CalendarIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { PRESET_LABEL, type RangeKey, type RangePreset, type ResolvedRange, rangeLabel } from '@/lib/time-range';
import { Segmented } from './segmented';


function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface RangeChange {
  range: RangeKey;
  from?: string | undefined;
  to?: string | undefined;
}

/** Custom from/to editor (local time inputs → ISO UTC). Validates order before applying. */
function CustomRange({ value, onApply }: { value: ResolvedRange; onApply: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(toLocalInput(value.from));
  const [to, setTo] = useState(toLocalInput(value.to));
  const f = Date.parse(from);
  const t = Date.parse(to);
  const error = Number.isNaN(f) || Number.isNaN(t) ? 'Enter both dates' : t <= f ? 'End must be after start' : null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onApply(new Date(f).toISOString(), new Date(t).toISOString());
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="range-from">From</Label>
        <Input id="range-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="range-to">To</Label>
        <Input id="range-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
      <p className="text-xs text-muted-foreground">Ranges are capped at 31 days.</p>
      <Button type="submit" size="sm" disabled={!!error}>
        Apply range
      </Button>
    </form>
  );
}

/**
 * Time range control: preset segments (prototype Observability) or a single dropdown-style
 * button (prototype Audit), plus a custom range popover.
 */
export function TimeRangePicker({ value, onChange, presets, variant = 'segments' }: { value: ResolvedRange; onChange: (next: RangeChange) => void; presets: readonly RangePreset[]; variant?: 'segments' | 'button' }) {
  const [open, setOpen] = useState(false);
  const custom = (
    <PopoverContent align="start" className="w-72">
      <CustomRange
        value={value}
        onApply={(from, to) => {
          onChange({ range: 'custom', from, to });
          setOpen(false);
        }}
      />
    </PopoverContent>
  );
  if (variant === 'button') {
    return (
      <div className="flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<Button variant="outline" className="h-9" />}>
            <CalendarIcon /> {rangeLabel(value)}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <div className="flex flex-col gap-1" role="group" aria-label="Presets">
              {presets.map((p) => (
                <Button
                  key={p}
                  variant={value.key === p ? 'secondary' : 'ghost'}
                  className="justify-start"
                  onClick={() => {
                    onChange({ range: p });
                    setOpen(false);
                  }}
                >
                  {PRESET_LABEL[p]}
                </Button>
              ))}
            </div>
            <div className="border-t pt-3">
              <CustomRange
                value={value}
                onApply={(from, to) => {
                  onChange({ range: 'custom', from, to });
                  setOpen(false);
                }}
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        label="Time range"
        value={value.key}
        onChange={(v) => onChange({ range: v })}
        options={presets.map((p) => ({ value: p as RangeKey, label: p }))}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant={value.key === 'custom' ? 'secondary' : 'ghost'} size="sm" aria-pressed={value.key === 'custom'} />}>
          <CalendarIcon /> {value.key === 'custom' ? rangeLabel(value) : 'Custom'}
        </PopoverTrigger>
        {custom}
      </Popover>
    </div>
  );
}
