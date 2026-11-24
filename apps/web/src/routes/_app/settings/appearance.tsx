import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/layout/page-header';
import { parseTheme } from '@/components/theme/theme-core';
import { useTheme } from '@/components/theme/theme-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { formatDateTime } from '@/lib/format';
import { useNow } from '@/hooks/use-now';
import { setDisplayPrefs, useDisplayPrefs } from '@/lib/display-prefs';

export const Route = createFileRoute('/_app/settings/appearance')({
  staticData: { crumbs: ['Settings', 'Appearance'] },
  component: AppearancePage,
});

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System', hint: 'Follows your operating system' },
] as const;

const TIME_OPTIONS = [
  { value: 'local', label: 'Local time', hint: 'Your browser time zone' },
  { value: 'utc', label: 'UTC' },
] as const;

const DENSITY_OPTIONS = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact', hint: 'Shorter table rows' },
] as const;

function Choices({ name, value, options, onChange }: { name: string; value: string; options: readonly { value: string; label: string; hint?: string }[]; onChange: (v: string) => void }) {
  // ids must not contain spaces ("Time display-local"), or the labels don't name the radios
  const idBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(String(v))} aria-label={name} className="gap-3">
      {options.map((o) => (
        <div key={o.value} className="flex items-center gap-3">
          <RadioGroupItem value={o.value} id={`${idBase}-${o.value}`} />
          <Label htmlFor={`${idBase}-${o.value}`} className="font-normal">
            {o.label}
            {o.hint ? <span className="text-muted-foreground"> · {o.hint}</span> : null}
          </Label>
        </div>
      ))}
    </RadioGroup>
  );
}

function AppearancePage() {
  const { theme, setTheme } = useTheme();
  const prefs = useDisplayPrefs();
  const sample = useNow(60_000);
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader title="Appearance" description="The theme follows your account; time and density are stored on this device." />
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>Light, dark, or match your system.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup value={theme} onValueChange={(v) => setTheme(parseTheme(String(v)))} aria-label="Theme" className="gap-3">
            {OPTIONS.map((o) => (
              <div key={o.value} className="flex items-center gap-3">
                <RadioGroupItem value={o.value} id={`theme-${o.value}`} />
                <Label htmlFor={`theme-${o.value}`} className="font-normal">
                  {o.label}
                  {'hint' in o ? <span className="text-muted-foreground"> · {o.hint}</span> : null}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Time display</CardTitle>
          <CardDescription>
            How timestamps appear in tables and details. Now: <span className="tabular-nums">{formatDateTime(sample, { utc: prefs.timeDisplay === 'utc' })}</span>
            {prefs.timeDisplay === 'utc' ? ' UTC' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Choices name="Time display" value={prefs.timeDisplay} options={TIME_OPTIONS} onChange={(v) => setDisplayPrefs({ timeDisplay: v === 'utc' ? 'utc' : 'local' })} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Table density</CardTitle>
          <CardDescription>Row height in data tables.</CardDescription>
        </CardHeader>
        <CardContent>
          <Choices name="Table density" value={prefs.density} options={DENSITY_OPTIONS} onChange={(v) => setDisplayPrefs({ density: v === 'compact' ? 'compact' : 'comfortable' })} />
        </CardContent>
      </Card>
    </div>
  );
}
