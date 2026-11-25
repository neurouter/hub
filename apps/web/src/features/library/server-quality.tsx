import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { Section } from '@/components/layout/section';
import { FlagList, GradeBreakdown } from './grade';
import { serverQualityQuery } from './queries';

/** The same deterministic grade the library uses, from this gateway's own evidence (health, definitions, usage). */
export function ServerQuality({ serverId }: { serverId: string }) {
  const q = useQuery(serverQualityQuery(serverId));
  return (
    <Section title="Quality grade" description="From our health checks, the current tool definitions, definition changes and usage, plus the registry entry if the server came from the library.">
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="flex flex-col gap-4">
          <FlagList flags={q.data.flags} />
          <GradeBreakdown quality={q.data} />
        </div>
      )}
    </Section>
  );
}
