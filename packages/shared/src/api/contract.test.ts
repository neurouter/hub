import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { ALL_ENDPOINTS, api, isNonSpaPath } from './routes.js';
import { buildPath, pathParamNames, serializeQuery } from './endpoint.js';
import { PROBLEM_CODES, Page, Problem, isRedactedMarker, problemType, timeRangeIssue, toProblemPath } from './common.js';
import { CreateAgentBody, Agent, UpdateAgentBody } from './agents.js';
import { AuditEventsQuery } from './audit.js';
import { isSafeReturnTo } from './auth.js';
import { CreateServerBody, ServerAuthIn } from './servers.js';
import { ListToolsQuery } from './tools.js';
import { Settings } from './settings.js';
import { AuditDecision } from '../domain/enums.js';

describe('endpoint registry', () => {
  it('has unique method + path pairs', () => {
    const seen = new Set<string>();
    for (const { key, def } of ALL_ENDPOINTS) {
      const id = `${def.method} ${def.path}`;
      expect(seen.has(id), `${key} duplicates ${id}`).toBe(false);
      seen.add(id);
    }
  });

  it('every path is under /api and declares params matching its :segments', () => {
    for (const { key, def } of ALL_ENDPOINTS) {
      expect(def.path.startsWith('/api/'), key).toBe(true);
      const names = pathParamNames(def.path);
      if (names.length === 0) {
        expect(def.params, `${key} has params but no :segments`).toBeUndefined();
        continue;
      }
      expect(def.params, `${key} needs a params schema`).toBeDefined();
      const shape = (def.params as z.ZodObject).shape as Record<string, unknown>;
      expect(Object.keys(shape).sort(), key).toEqual([...names].sort());
    }
  });

  it('json endpoints declare a response; empty ones return 204; GETs have no body', () => {
    for (const { key, def } of ALL_ENDPOINTS) {
      if (def.kind === 'json') expect(def.response, key).toBeDefined();
      if (def.kind === 'empty') expect(def.status, key).toBe(204);
      if (def.method === 'GET') expect(def.body, key).toBeUndefined();
      if (def.kind === 'navigation') expect(def.method, key).toBe('GET');
    }
  });

  it('covers every backend §14.3 area', () => {
    expect(Object.keys(api)).toEqual(expect.arrayContaining(['auth', 'me', 'servers', 'tools', 'grants', 'audit', 'metrics', 'sessions', 'settings', 'oauth']));
    expect(ALL_ENDPOINTS.length).toBeGreaterThanOrEqual(100);
  });
});

describe('path and query helpers', () => {
  it('buildPath encodes params and throws on missing ones', () => {
    expect(buildPath('/api/agents/:id/keys/:keyId', { id: 'a b', keyId: 'k' })).toBe('/api/agents/a%20b/keys/k');
    expect(() => buildPath('/api/agents/:id', {})).toThrow(/Missing path param/);
  });
  it('serializeQuery repeats array keys, drops empties and formats dates', () => {
    const d = new Date('2026-11-24T10:00:00.000Z');
    expect(serializeQuery({ decision: ['allowed', 'denied_acl'], q: '', x: undefined, y: null, from: d, n: 0, b: false })).toBe(
      '?decision=allowed&decision=denied_acl&from=2026-11-24T10%3A00%3A00.000Z&n=0&b=false',
    );
    expect(serializeQuery({})).toBe('');
  });
  it('query schemas accept repeated keys and single values', () => {
    expect(ListToolsQuery.parse({ serverId: 's1', requiresApproval: 'true', limit: '20' })).toMatchObject({ serverId: ['s1'], requiresApproval: true, limit: 20 });
    expect(ListToolsQuery.parse({ serverId: ['a', 'b'], q: '' })).toMatchObject({ serverId: ['a', 'b'], q: undefined });
    expect(() => ListToolsQuery.parse({ limit: '500' })).toThrow();
    expect(() => ListToolsQuery.parse({ sort: 'bogus' })).toThrow();
  });
  it('isNonSpaPath', () => {
    expect(isNonSpaPath('/api/me')).toBe(true);
    expect(isNonSpaPath('/.well-known/oauth-authorization-server')).toBe(true);
    expect(isNonSpaPath('/healthz')).toBe(true);
    expect(isNonSpaPath('/catalog')).toBe(false);
    expect(isNonSpaPath('/apiary')).toBe(false);
  });
});

describe('problem+json', () => {
  it('maps codes to stable types and statuses', () => {
    expect(problemType('validation_failed')).toBe('https://neurouter.dev/problems/validation-failed');
    expect(PROBLEM_CODES.rate_limited.status).toBe(429);
    expect(PROBLEM_CODES.gone.status).toBe(410);
  });
  it('parses the documented example', () => {
    const p = Problem.parse({
      type: problemType('validation_failed'), title: 'Validation failed', status: 422, detail: '2 fields are invalid',
      instance: '/api/servers', code: 'validation_failed', requestId: '0193',
      errors: [{ path: ['auth', 'headerName'], message: 'Required', code: 'required' }],
    });
    expect(p.errors?.[0]?.path).toEqual(['auth', 'headerName']);
    expect(toProblemPath(['a', 0, 'b'])).toEqual(['a', '0', 'b']);
  });
  it('Page envelope', () => {
    expect(Page(z.number()).parse({ items: [1], nextCursor: null })).toEqual({ items: [1], nextCursor: null });
  });
});

describe('contract details', () => {
  it('agents have no exposure mode in Phase 1 (frontend addendum #1)', () => {
    expect(() => CreateAgentBody.parse({ name: 'bot', exposureMode: 'list' })).toThrow();
    expect(() => UpdateAgentBody.parse({ exposureMode: 'meta' })).toThrow();
    expect('exposureMode' in Agent.shape).toBe(false);
    expect('toolExposureDefault' in Settings.shape).toBe(false);
  });
  it('audit decisions include `approved` (frontend addendum #3)', () => {
    expect(AuditDecision.options).toContain('approved');
    expect(AuditDecision.options).toContain('approval_approved');
  });
  it('audit queries require a bounded time range', () => {
    expect(() => AuditEventsQuery.parse({})).toThrow();
    const ok = AuditEventsQuery.parse({ from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z', decision: 'allowed' });
    expect(ok.decision).toEqual(['allowed']);
    expect(() => AuditEventsQuery.parse({ from: '2026-01-01T00:00:00Z', to: '2026-11-02T00:00:00Z' })).toThrow(/31 days/);
    expect(timeRangeIssue('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z')).toMatch(/after/);
  });
  it('server auth is a discriminated union with write-only secrets', () => {
    expect(ServerAuthIn.parse({ type: 'shared_header', headerName: 'X-Api-Key', headerValue: 's' })).toBeTruthy();
    expect(() => ServerAuthIn.parse({ type: 'shared_header', headerName: 'bad header', headerValue: 's' })).toThrow();
    expect(() => ServerAuthIn.parse({ type: 'shared_bearer' })).toThrow();
    const body = CreateServerBody.parse({
      name: 'GitHub', slug: 'github', ownerId: 'u1', url: 'https://mcp.example.com/mcp', transport: 'streamable_http', auth: { type: 'none' },
    });
    expect(body.tags).toEqual([]);
    expect(() => CreateServerBody.parse({ ...body, slug: 'Git_Hub' })).toThrow();
  });
  it('redaction markers', () => {
    expect(isRedactedMarker({ $redacted: 'password' })).toBe(true);
    expect(isRedactedMarker({ $redacted: 'x', other: 1 })).toBe(false);
    expect(isRedactedMarker('x')).toBe(false);
  });
});

describe('isSafeReturnTo', () => {
  it.each([
    ['/catalog', true], ['/admin/tools?status=pending_review', true],
    ['//evil.com', false], ['/\\evil.com', false], ['https://evil.com', false], ['javascript:alert(1)', false],
    ['', false], [null, false], ['/\t/evil', false], ['catalog', false],
  ])('%s → %s', (v, ok) => expect(isSafeReturnTo(v as string | null)).toBe(ok));
});
