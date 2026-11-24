import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { OIDC_SETTINGS, SETTINGS } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';

describe('/admin/settings', () => {
  it('general: validates and PATCHes only the general fields', async () => {
    let body: unknown;
    const { user } = await renderRoute('/admin/settings', {
      fixtures: {
        'settings.update': async ({ request }: { request: Request }) => {
          body = await request.json();
          return { ...SETTINGS, retention: { ...SETTINGS.retention, auditDays: 90 } };
        },
      },
    });
    const audit = await screen.findByLabelText('Audit log (days)');
    await user.clear(audit);
    await user.type(audit, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/too small|>=1/i)).toBeInTheDocument();
    await user.clear(audit);
    await user.type(audit, '90');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ retention: { auditDays: 90, metricsDays: 90, storeFullOutput: false }, approvals: { timeoutMinutes: 5 }, sessions: { idleMinutes: 15 } }));
  });

  it('rate limits tab saves agent and tool buckets', async () => {
    let body: unknown;
    const { user } = await renderRoute('/admin/settings?tab=rate-limits', {
      fixtures: { 'settings.update': async ({ request }: { request: Request }) => ((body = await request.json()), SETTINGS) },
    });
    const rpm = (await screen.findAllByLabelText('Requests per minute'))[0]!;
    await user.clear(rpm);
    await user.type(rpm, '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ rateLimits: { agent: { perMinute: 30, burst: 20 }, tool: { perMinute: 120, burst: 40 } } }));
  });

  it('authentication: OIDC is env-only; role mappings are edited and saved together', async () => {
    let body: unknown;
    const { user } = await renderRoute('/admin/settings?tab=authentication', {
      fixtures: { 'settings.updateOidc': async ({ request }: { request: Request }) => ((body = await request.json()), { ...OIDC_SETTINGS, ...(body as object) }) },
    });
    expect(await screen.findByText(/configured via environment variables/i)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Role mappings' });
    expect(within(table).getByText('okta-platform-admins')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Value'), 'okta-soc');
    await user.click(screen.getByRole('button', { name: 'Add mapping' }));
    await user.click(within(table).getByRole('button', { name: 'Remove mapping okta-security-audit → auditor' }));
    await user.click(screen.getByRole('button', { name: 'Save role mappings' }));
    await waitFor(() =>
      expect(body).toEqual({
        roleMappings: [
          { claim: 'groups', value: 'okta-platform-admins', role: 'admin' },
          { claim: 'groups', value: 'okta-soc', role: 'admin' },
        ],
      }),
    );
  });

  it('auditors see settings read-only', async () => {
    await renderRoute('/admin/settings?tab=authentication', { me: meFixture('auditor') });
    expect(await screen.findByText('okta-platform-admins')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save role mappings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add mapping' })).not.toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });
});

describe('/settings/profile', () => {
  it('shows identity, additive roles and groups', async () => {
    await renderRoute('/settings/profile', { me: meFixture('owner') });
    expect(await screen.findByText('marco.ruiz@acme.example')).toBeInTheDocument();
    expect(screen.getByText('Server owner')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });
});

describe('/settings/appearance', () => {
  it('stores theme, time display and table density on this device', async () => {
    const { user } = await renderRoute('/settings/appearance');
    expect(await screen.findByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'UTC' }));
    await user.click(screen.getByRole('radio', { name: /Compact/ }));
    expect(JSON.parse(localStorage.getItem('neurouter-display')!)).toEqual({ timeDisplay: 'utc', density: 'compact' });
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(screen.getByText(/UTC$/, { selector: 'div,p' })).toBeInTheDocument();
  });

  it('every radio has an accessible name and a whitespace-free id for its label', async () => {
    await renderRoute('/settings/appearance');
    await screen.findByRole('radiogroup', { name: 'Theme' });
    for (const name of ['Light', 'Dark', /System/, /Local time/, 'UTC', 'Comfortable', /Compact/]) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    }
    for (const label of document.querySelectorAll('label[for]')) expect(label.getAttribute('for')).not.toMatch(/\s/);
  });
});
