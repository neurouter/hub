import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { PROBLEM_CONTENT_TYPE, problemType } from '@neurouter/shared';
import { CONSENT_ID, consentRequest } from '@/mocks/demo-data';
import { browserNavigation } from '@/lib/navigation';
import { renderRoute } from '@/test/render';
import { defaultAgentName, minutesLeft, safeLogo } from './consent-page';

const problem = (status: number, code: string, title: string) =>
  HttpResponse.json({ type: problemType(code), title, status, code, requestId: 't' }, { status, headers: { 'content-type': PROBLEM_CONTENT_TYPE } });
const url = `/auth/consent?request=${CONSENT_ID}`;

describe('consent helpers', () => {
  it('derives a default agent name, minutes left and a same-origin-only logo', () => {
    expect(defaultAgentName('Quillmate Desktop', 'dana.whitfield@acme.example')).toBe('quillmate-desktop @ dana.whitfield');
    expect(defaultAgentName('***', 'a@b')).toBe('mcp-client @ a');
    expect(minutesLeft('2026-11-24T10:09:00.000Z', Date.parse('2026-11-24T10:00:30.000Z'))).toBe(9);
    expect(minutesLeft('2026-11-24T10:00:00.000Z', Date.parse('2026-11-24T10:05:00.000Z'))).toBe(0);
    expect(safeLogo('/api/oauth-clients/x/logo')).toBe('/api/oauth-clients/x/logo');
    expect(safeLogo('https://evil.example/logo.png')).toBeNull();
    expect(safeLogo('//evil.example/logo.png')).toBeNull();
    expect(safeLogo(null)).toBeNull();
  });
});

describe('/auth/consent (W10 acceptance)', () => {
  it('unverified (DCR) client: warning, self-declared id, redirect host verbatim, scopes with descriptions', async () => {
    await renderRoute(url, { fixtures: { 'oauth.getConsent': consentRequest(false) } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Quillmate Desktop wants to use Neurouter Hub as you' })).toBeInTheDocument();
    expect(screen.getByText('Unverified app · dynamically registered')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Neurouter Hub couldn't verify who made this app");
    expect(screen.getByText('Quillmate Desktop (self-declared)')).toBeInTheDocument();
    expect(screen.getByText('client_id dcr_01JDBC7Q4M8X2ZK9')).toBeInTheDocument();
    expect(screen.getByText('[::1]:33418')).toBeInTheDocument();
    const scopes = screen.getByRole('list', { name: 'Requested permissions' });
    expect(within(scopes).getByText('mcp:tools')).toBeInTheDocument();
    expect(within(scopes).getByText('Find and call tools you have access to')).toBeInTheDocument();
    expect(screen.getByText('dana.whitfield@acme.example')).toBeInTheDocument();
    // no sidebar (minimal layout)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    // Approve is not auto-focused
    expect(screen.getByRole('button', { name: 'Approve' })).not.toHaveFocus();
  });

  it('verified CIMD client shows the client_id host verbatim and no warning', async () => {
    await renderRoute(url, { fixtures: { 'oauth.getConsent': consentRequest(true) } });
    expect(await screen.findByText('Verified metadata document (CIMD)')).toBeInTheDocument();
    expect(screen.getByText('quillmate.example')).toBeInTheDocument();
    expect(screen.getByText('https://quillmate.example/.well-known/oauth-client.json')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Approve posts the new-agent binding and leaves with location.replace(redirectTo)', async () => {
    const replace = vi.spyOn(browserNavigation, 'replace').mockImplementation(() => {});
    let sent: unknown;
    const { user } = await renderRoute(url, {
      fixtures: {
        'oauth.getConsent': consentRequest(true),
        'oauth.decideConsent': async ({ request }: { request: Request }) => {
          sent = await request.json();
          return { redirectTo: 'http://[::1]:33418/callback?code=abc&state=s&iss=x' };
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('http://[::1]:33418/callback?code=abc&state=s&iss=x'));
    expect(sent).toEqual({ decision: 'approve', agentName: 'quillmate-desktop @ dana.whitfield' });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });

  it('Deny posts deny without a binding', async () => {
    vi.spyOn(browserNavigation, 'replace').mockImplementation(() => {});
    let sent: unknown;
    const { user } = await renderRoute(url, {
      fixtures: {
        'oauth.getConsent': consentRequest(false),
        'oauth.decideConsent': async ({ request }: { request: Request }) => {
          sent = await request.json();
          return { redirectTo: 'http://[::1]:33418/callback?error=access_denied' };
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(sent).toEqual({ decision: 'deny' }));
  });

  it('an expired request (410) shows the expiry message', async () => {
    await renderRoute(url, { fixtures: { 'oauth.getConsent': () => problem(410, 'gone', 'Gone') } });
    expect(await screen.findByRole('heading', { name: 'This authorization request has expired' })).toBeInTheDocument();
    expect(screen.getByText('Return to your app and try again.')).toBeInTheDocument();
  });

  it('a request for another user (403) offers sign out', async () => {
    await renderRoute(url, { fixtures: { 'oauth.getConsent': () => problem(403, 'forbidden', 'Forbidden') } });
    expect(await screen.findByRole('heading', { name: 'This request belongs to a different account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('expiry during the decision is explained', async () => {
    const { user } = await renderRoute(url, { fixtures: { 'oauth.getConsent': consentRequest(true), 'oauth.decideConsent': () => problem(410, 'gone', 'Gone') } });
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/has expired\. Return to your app/)).toBeInTheDocument();
  });

  it('missing ?request shows guidance', async () => {
    await renderRoute('/auth/consent');
    expect(await screen.findByRole('heading', { name: 'Missing authorization request' })).toBeInTheDocument();
  });
});
