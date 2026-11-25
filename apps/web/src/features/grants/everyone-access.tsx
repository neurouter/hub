import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EVERYONE_GROUP_ID, api } from '@neurouter/shared';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { apiFetch } from '@/lib/api-client';
import { notifyError, notifySuccess } from '@/lib/notify';
import { grantKeys, grantsListQuery } from './queries';

/**
 * Admin switch on a server's Access tab: a server-wide allow grant to the built-in Everyone group.
 * Deny grants still win, and narrowed agents still need their own grant.
 */
export function EveryoneAccess({ serverId, serverName }: { serverId: string; serverName: string }) {
  const qc = useQueryClient();
  const q = useQuery(grantsListQuery({ serverId, subjectType: 'group', subjectId: EVERYONE_GROUP_ID, effect: 'allow', limit: 50 }));
  const grant = q.data?.items.find((g) => g.target.type === 'server' && g.target.id === serverId);
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) await apiFetch(api.grants.create, { body: { subject: { type: 'group', id: EVERYONE_GROUP_ID }, target: { type: 'server', id: serverId }, effect: 'allow' } });
      else if (grant) await apiFetch(api.grants.delete, { params: { id: grant.id } });
    },
    onSuccess: (_, on) => {
      notifySuccess(on ? `${serverName} is available to everyone` : `${serverName} is no longer available to everyone`);
      void qc.invalidateQueries({ queryKey: grantKeys.all });
    },
    onError: (err) => notifyError(err, 'Could not change access'),
  });
  return (
    <div className="flex items-center gap-2" title="Every user (and their agents) may call this server's approved tools. Deny grants still win.">
      <Switch id={`everyone-${serverId}`} checked={!!grant} disabled={q.isLoading || toggle.isPending} onCheckedChange={(on) => toggle.mutate(on)} />
      <Label htmlFor={`everyone-${serverId}`} className="text-[13px] font-normal">
        Available to everyone
      </Label>
    </div>
  );
}
