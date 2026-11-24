import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { initials } from '@/lib/initials';
import { cn } from '@/lib/utils';

/** Initials avatar (remote avatar URLs are not loaded: CSP img-src is 'self', Q9). */
export function UserAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <Avatar className={cn('size-7', className)}>
      <AvatarFallback className="text-[11px] font-semibold">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}
