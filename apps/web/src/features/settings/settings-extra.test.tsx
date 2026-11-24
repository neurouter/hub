import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { meFixture } from '@/mocks/fixtures';
import { REDACTION_RULES, SETTINGS } from '@/mocks/demo-data';
import { renderRoute } from '@/test/render';
import { accessPatch, parseHosts } from './access-section';
import { exportPatch } from './export-tab';
import { parseSample, patternError } from './redaction-tab';

describe('settings helpers', () => {
  it('validates regex patterns with the server flags', () => {
    expect(patternError('key', '(pass|token)')).toBeNull();
    expect(patternError('regex', 'Bearer\\s+\\S+')).toBeNull();
    expect(patternError('regex', '(unclosed')).toMatch(/^Invalid regular expression/);
    expect(patternError('key', '')).toBe('Enter a pattern');
  });

  it('parses the test sample as a JSON object', () => {
    expect(parseSample('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseSample('[1]')).toMatchObject({ ok: false });
    expect(parseSample('{nope')).toEqual({ ok: false, error: 'Not valid JSON.' });
  });

  it('builds minimal PATCH bodies (secret only when replaced)', () => {
    const cur = SETTINGS.export;
    expect(exportPatch({ webhookUrl: '', webhookEnabled: false, otlpLogsEnabled: false, webhookSecret: '' }, cur)).toEqual({ export: {} });
    expect(exportPatch({ webhookUrl: 'https://siem.example/x', webhookEnabled: true, otlpLogsEnabled: false, webhookSecret: 'a'.repeat(20) }, cur)).toEqual({
      export: { webhookUrl: 'https://siem.example/x', webhookEnabled: true, webhookSecret: 'a'.repeat(20) },
    });
    expect(parseHosts(' claude.ai\nClaude.ai, *.cursor.com\n\n')).toEqual(['claude.ai', '*.cursor.com']);
    expect(accessPatch({ catalogVisibility: 'granted', dcrEnabled: false, cimdMode: 'allowlist', hosts: 'claude.ai' })).toEqual({
      catalogVisibility: 'granted',
      oauth: { dcrEnabled: false, cimdPolicy: { mode: 'allowlist', allowedHosts: ['claude.ai'] } },
    });
  });
});

describe('/admin/settings redaction, export, clients', () => {
  it('redaction: lists rules by order, toggles enabled, validates regex in the dialog and creates a rule', async () => {
    const update = vi.fn(async ({ request }: { request: Request }) => ({ ...REDACTION_RULES[3]!, ...((await request.json()) as object) }));
    let created: unknown;
    const { user } = await renderRoute('/admin/settings?tab=redaction', {
      fixtures: {
        'redaction.update': update,
        'redaction.create': async ({ request }: { request: Request }) => {
          created = await request.json();
          return { ...REDACTION_RULES[2]!, id: 'new', ...(created as object) };
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'Redaction rules' });
    await within(table).findByText('secret-values');
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(names).toEqual(['sensitive-keyBuilt-in', 'bearer-tokenBuilt-in', 'emailBuilt-in', 'secret-values']);
    // built-in rules have no edit/delete
    expect(within(table).queryByRole('button', { name: 'Edit sensitive-key' })).not.toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Delete secret-values' })).toBeInTheDocument();
    await user.click(within(table).getByRole('switch', { name: 'Enable email' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'internal-ids');
    await user.click(within(dialog).getByRole('radio', { name: 'Values (regex)' }));
    await user.type(within(dialog).getByLabelText('Pattern'), 'ACME-[[0-9');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    expect(await within(dialog).findByText(/Invalid regular expression/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Pattern'), ']+');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(created).toEqual({ name: 'internal-ids', type: 'regex', pattern: 'ACME-[0-9]+', replacement: '', enabled: true }));
  });

  it('redaction test panel previews on the server and reports bad JSON locally', async () => {
    const { user } = await renderRoute('/admin/settings?tab=redaction');
    const sample = await screen.findByLabelText('Sample arguments (JSON)');
    await user.clear(sample);
    await user.type(sample, '[[1]');
    await user.click(screen.getByRole('button', { name: 'Preview redaction' }));
    expect(await screen.findByText('The sample must be a JSON object, like tool arguments.')).toBeInTheDocument();
    await user.clear(sample);
    await user.type(sample, '{{"api_token": "x", "repo": "a"}');
    await user.click(screen.getByRole('button', { name: 'Preview redaction' }));
    expect(await screen.findByText('1 value redacted.')).toBeInTheDocument();
    expect(screen.getByText(/REDACTED · sensitive-key/)).toBeInTheDocument();
  });

  it('auditors see redaction rules read-only (Q10)', async () => {
    await renderRoute('/admin/settings?tab=redaction', { me: meFixture('auditor') });
    await waitFor(() => expect(screen.getByText('Bearer\\s+\\S+')).toBeInTheDocument());
    const table = screen.getByRole('table', { name: 'Redaction rules' });
    expect(within(table).getByRole('switch', { name: 'Enable email' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sample arguments (JSON)')).not.toBeInTheDocument();
  });

  it('export: write-only secret, save, and send a test event', async () => {
    let body: unknown;
    const withUrl = { ...SETTINGS, export: { ...SETTINGS.export, webhookUrl: 'https://siem.example/in', hasWebhookSecret: true } };
    const { user } = await renderRoute('/admin/settings?tab=export', {
      fixtures: {
        'settings.get': withUrl,
        'settings.update': async ({ request }: { request: Request }) => ((body = await request.json()), withUrl),
        'settings.testExport': { ok: false, status: 502, error: 'Bad gateway' },
      },
    });
    expect(await screen.findByText('A secret is set')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace secret' }));
    const secret = screen.getByLabelText('Signing secret');
    expect(secret).toHaveValue('');
    await user.type(secret, 'short');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use at least 16 characters')).toBeInTheDocument();
    await user.type(secret, '-but-now-long-enough');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ export: { webhookSecret: 'short-but-now-long-enough' } }));
    await user.click(screen.getByRole('button', { name: 'Send test event' }));
    expect(await screen.findByText(/Failed · HTTP 502 · Bad gateway/)).toBeInTheDocument();
  });

  it('export from env is read-only', async () => {
    await renderRoute('/admin/settings?tab=export', { fixtures: { 'settings.get': { ...SETTINGS, export: { ...SETTINGS.export, source: 'env' } } } });
    expect(await screen.findByText(/configured via environment variables/)).toBeInTheDocument();
    expect(screen.getByLabelText('Webhook URL')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('general: catalog and client settings save separately', async () => {
    let body: unknown;
    const { user } = await renderRoute('/admin/settings', {
      fixtures: { 'settings.update': async ({ request }: { request: Request }) => ((body = await request.json()), SETTINGS) },
    });
    await user.click(await screen.findByRole('radio', { name: 'Only these hosts' }));
    await user.click(screen.getByRole('button', { name: 'Save catalog and client settings' }));
    expect(await screen.findByText('Add at least one host, or allow any host')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Allowed client hosts'), 'claude.ai');
    await user.click(screen.getByRole('button', { name: 'Save catalog and client settings' }));
    await waitFor(() =>
      expect(body).toEqual({ catalogVisibility: 'all', oauth: { dcrEnabled: true, cimdPolicy: { mode: 'allowlist', allowedHosts: ['claude.ai'] } } }),
    );
  });
});
