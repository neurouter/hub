import type { ReactNode } from 'react';
import { AlertCircleIcon, LockIcon, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';

export function EmptyState({ icon: Icon, title, description, action }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
        ) : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

/** 403 rendered in place (URL unchanged, shareable). */
export function ForbiddenState({ message = "You don't have access to this page." }: { message?: string }) {
  return (
    <div role="alert" className="mx-auto w-full max-w-xl py-10">
      <EmptyState icon={LockIcon} title="Access denied" description={`${message} Ask an administrator if you think you should.`} />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  return (
    <Alert variant="destructive" className="max-w-2xl">
      <AlertCircleIcon />
      <AlertTitle>{api?.title ?? 'Something went wrong'}</AlertTitle>
      <AlertDescription>
        {api ? (api.detail ? <p>{api.detail}</p> : null) : <p>{error instanceof Error ? error.message : 'Unexpected error'}</p>}
        {api?.requestId ? <p className="font-mono text-xs">Request ID: {api.requestId}</p> : null}
        {onRetry ? (
          <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
