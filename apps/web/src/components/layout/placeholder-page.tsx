import { ConstructionIcon } from 'lucide-react';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from './page-header';

/** Skeleton page for routes whose features land in later Phase 1 steps. */
export function PlaceholderPage({ title, description, step }: { title: string; description?: string; step: string }) {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={title} {...(description ? { description } : {})} />
      <EmptyState icon={ConstructionIcon} title="Coming soon" description={`This page is built in Phase 1 ${step}.`} />
    </div>
  );
}
