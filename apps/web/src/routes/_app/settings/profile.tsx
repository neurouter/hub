import { Link, createFileRoute } from '@tanstack/react-router';
import { LockIcon } from 'lucide-react';
import { displayRoles, type DisplayRole } from '@neurouter/shared';
import { PageHeader } from '@/components/layout/page-header';
import { DetailList, Page, Section } from '@/components/layout/section';
import { UserAvatar } from '@/components/layout/user-avatar';
import { Pill } from '@/components/status/status';
import { useMe } from '@/hooks/use-me';

export const Route = createFileRoute('/_app/settings/profile')({
  staticData: { crumbs: ['Settings', 'Profile'] },
  component: ProfilePage,
});

const ROLE: Record<DisplayRole, { label: string; hint: string }> = {
  admin: { label: 'Admin', hint: 'Full control of the gateway.' },
  auditor: { label: 'Auditor', hint: 'Read-only access to everything, plus audit export and verification.' },
  owner: { label: 'Server owner', hint: 'Manages the servers you own: tools, grants, access requests and approvals.' },
  user: { label: 'User', hint: 'Browse the catalog, create agents and request access.' },
};

/** Profile (§5.5): identity from the IdP (read-only), roles and groups. */
function ProfilePage() {
  const me = useMe();
  return (
    <Page width="form">
      <PageHeader title="Profile" description="Your account comes from your identity provider and is read-only here." />
      <Section>
        <div className="flex items-start gap-4">
          <UserAvatar name={me.user.name} className="size-12" />
          <DetailList
            className="flex-1"
            items={[
              { label: 'Name', value: me.user.name },
              { label: 'Email', value: me.user.email },
              { label: 'Organisation', value: me.org.name },
            ]}
          />
        </div>
      </Section>
      <Section title="Roles" description="Roles are additive. Everyone is a User.">
        <ul className="flex flex-col gap-2">
          {displayRoles(me).map((r) => (
            <li key={r} className="flex flex-col">
              <span className="font-medium">{ROLE[r].label}</span>
              <span className="text-[13px] text-muted-foreground">
                {ROLE[r].hint}
                {r === 'owner' ? ` (${me.ownedServerIds.length} server${me.ownedServerIds.length === 1 ? '' : 's'})` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Groups">
        {me.groups.length === 0 ? <p className="text-muted-foreground">You're not in any group.</p> : null}
        <ul className="flex flex-wrap gap-2">
          {me.groups.map((g) => (
            <li key={g.id}>
              {g.source === 'oidc' ? <Pill tone="muted" icon={LockIcon}>{g.name}</Pill> : <Pill tone="outline">{g.name}</Pill>}
            </li>
          ))}
        </ul>
      </Section>
      <p className="text-[13px] text-muted-foreground">
        Theme and display options are under{' '}
        <Link to="/settings/appearance" className="font-medium text-foreground underline-offset-4 hover:underline">
          Appearance
        </Link>
        .
      </p>
    </Page>
  );
}
