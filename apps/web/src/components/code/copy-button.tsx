import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Writes to the clipboard; resolves false when the API is unavailable or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy button with a transient "Copied" state. Icon-only unless `label` is given. */
export function CopyButton({
  value, label, ariaLabel = 'Copy', className, size = 'icon-xs', variant = 'ghost',
}: { value: string; label?: string; ariaLabel?: string; className?: string; size?: 'icon-xs' | 'icon-sm' | 'xs' | 'sm'; variant?: 'ghost' | 'outline' }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <Button
      type="button"
      variant={variant}
      size={label ? (size === 'icon-xs' ? 'xs' : size === 'icon-sm' ? 'sm' : size) : size}
      className={cn('shrink-0', className)}
      aria-label={label ? undefined : copied ? 'Copied' : ariaLabel}
      onClick={() => void copyText(value).then((ok) => setCopied(ok))}
    >
      <Icon />
      {label ? (copied ? 'Copied' : label) : null}
    </Button>
  );
}

/** Monospace value with middle-ellipsis display and a copy button (ids, hashes). */
export function CopyableMono({ value, display, ariaLabel }: { value: string; display?: string; ariaLabel?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-[12.5px]" title={value}>
        {display ?? value}
      </span>
      <CopyButton value={value} ariaLabel={ariaLabel ?? `Copy ${value}`} />
    </span>
  );
}
