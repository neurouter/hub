import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';

/** Prev / Next for cursor pagination (frontend §6.3). Renders nothing when there's a single page. */
export function CursorPager({
  page, hasPrev, hasNext, onPrev, onNext, total, shown,
}: { page: number; hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void; total?: number | undefined; shown?: number }) {
  if (!hasPrev && !hasNext) {
    return total !== undefined || shown !== undefined ? (
      <p className="text-[13px] text-muted-foreground tabular-nums">{formatNumber(total ?? shown ?? 0)} total</p>
    ) : null;
  }
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
      <span className="tabular-nums">
        Page {page}
        {total !== undefined ? ` · about ${formatNumber(total)} total` : ''}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!hasPrev} onClick={onPrev}>
          <ChevronLeftIcon /> Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
          Next <ChevronRightIcon />
        </Button>
      </div>
    </nav>
  );
}
