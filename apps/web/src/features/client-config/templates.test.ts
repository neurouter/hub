import { describe, expect, it } from 'vitest';
import { CLIENTS, buildSnippet, type AuthMode } from './templates';

const config = { mcpUrl: 'https://mcp.acme.example/mcp', serverName: 'neurouter', protocolVersions: ['2026-07-28', '2025-11-25'] as ['2026-07-28', '2025-11-25'] };

describe('client config templates', () => {
  for (const c of CLIENTS) {
    for (const auth of ['oauth', 'api_key'] as AuthMode[]) {
      it(`${c.label} × ${auth}`, () => {
        expect(buildSnippet(c.id, { config, auth })).toMatchSnapshot();
      });
    }
  }

  it('interpolates a pasted key only when given, and never with OAuth', () => {
    expect(buildSnippet('cursor', { config, auth: 'api_key', key: 'nr_live_X' }).code).toContain('"Authorization": "Bearer nr_live_X"');
    expect(buildSnippet('cursor', { config, auth: 'api_key' }).code).toContain('${env:NEUROUTER_API_KEY}');
    expect(buildSnippet('claude', { config, auth: 'oauth', key: 'nr_live_X' }).code).not.toContain('nr_live_X');
    expect(buildSnippet('vscode', { config, auth: 'api_key' }).code).toContain('${input:neurouter-key}');
    expect(buildSnippet('generic', { config, auth: 'api_key' }).code).toContain('<YOUR_API_KEY>');
  });
});
