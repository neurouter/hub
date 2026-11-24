import { BotIcon, UserIcon, UsersIcon } from 'lucide-react';
import type { SubjectType } from '@neurouter/shared';
import { cn } from '@/lib/utils';

export const SUBJECT_ICON = { user: UserIcon, group: UsersIcon, agent: BotIcon } as const;
export const SUBJECT_LABEL: Record<SubjectType, string> = { user: 'User', group: 'Group', agent: 'Agent' };

/** Subject chip: type icon in a muted square + "type:name" (prototype AccessMatrix). */
export function SubjectCell({ type, name, hint, className }: { type: SubjectType; name: string; hint?: string; className?: string }) {
  const Icon = SUBJECT_ICON[type];
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] bg-muted" aria-hidden="true">
        <Icon className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-medium">
          <span className="sr-only">{SUBJECT_LABEL[type]} </span>
          {type}:{name}
        </span>
        {hint ? <span className="truncate text-[11.5px] text-muted-foreground">{hint}</span> : null}
      </span>
    </span>
  );
}
