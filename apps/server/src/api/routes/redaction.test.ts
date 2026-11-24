import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../../audit/sinks/webhook.js';
import { createTestContext, type TestContext, type TestUser } from '../../test/fakes/context.js';

describe('redaction rules + SIEM webhook test REST', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let auditor: TestUser;
  let posts: { url: string; headers: Record<string, string>; body: string }[];

  beforeEach(async () => {
    posts = [];
    ctx = await createTestContext({
      outboundFetch: async (url, init) => {
        posts.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) });
        return new Response(null, { status: String(url).includes('fail') ? 500 : 202 });
      },
    });
    admin = await ctx.user('admin@x.test', ['admin']);
    auditor = await ctx.user('auditor@x.test', ['auditor']);
  });
  afterEach(async () => ctx.close());

  it('seeds built-ins; admins add, edit, test and delete custom rules; built-ins are protected', async () => {
    const list = (await ctx.as(auditor, { method: 'GET', url: '/api/settings/redaction-rules' })).json().items as { id: string; name: string; builtin: boolean; enabled: boolean }[];
    expect(list.map((r) => r.name)).toEqual(expect.arrayContaining(['sensitive-key', 'jwt', 'credit-card', 'email']));
    expect(list.every((r) => r.builtin)).toBe(true);
    expect((await ctx.as(auditor, { method: 'POST', url: '/api/settings/redaction-rules', payload: { name: 'x', type: 'regex', pattern: 'x' } })).statusCode).toBe(403);

    const bad = await ctx.as(admin, { method: 'POST', url: '/api/settings/redaction-rules', payload: { name: 'slow', type: 'regex', pattern: '^(a+)+$' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0]).toMatchObject({ path: ['pattern'], code: 'regex_too_slow' });
    expect((await ctx.as(admin, { method: 'POST', url: '/api/settings/redaction-rules', payload: { name: 'broken', type: 'regex', pattern: '(' } })).json().errors[0].code).toBe('invalid_regex');

    const created = await ctx.as(admin, { method: 'POST', url: '/api/settings/redaction-rules', payload: { name: 'account', type: 'regex', pattern: 'ACCT-\\d+' } });
    expect(created.statusCode, created.body).toBe(201);
    const rule = created.json();
    expect((await ctx.as(admin, { method: 'POST', url: '/api/settings/redaction-rules', payload: { name: 'account', type: 'regex', pattern: 'x' } })).statusCode).toBe(409);

    const t = (await ctx.as(admin, { method: 'POST', url: '/api/settings/redaction/test', payload: { sample: { note: 'see ACCT-42', password: 'p' } } })).json();
    expect(t.redacted).toEqual({ note: 'see [REDACTED:account]', password: { $redacted: 'sensitive-key' } });
    expect(t.matches.map((m: { path: string[] }) => m.path)).toEqual(expect.arrayContaining([['note'], ['password']]));

    const upd = await ctx.as(admin, { method: 'PATCH', url: `/api/settings/redaction-rules/${rule.id}`, payload: { enabled: false } });
    expect(upd.json()).toMatchObject({ enabled: false });
    const after = (await ctx.as(admin, { method: 'POST', url: '/api/settings/redaction/test', payload: { sample: { note: 'see ACCT-42' } } })).json();
    expect(after.redacted).toEqual({ note: 'see ACCT-42' });

    const jwt = list.find((r) => r.name === 'jwt')!;
    expect((await ctx.as(admin, { method: 'PATCH', url: `/api/settings/redaction-rules/${jwt.id}`, payload: { pattern: 'x' } })).statusCode).toBe(422);
    expect((await ctx.as(admin, { method: 'PATCH', url: `/api/settings/redaction-rules/${jwt.id}`, payload: { enabled: false, order: 5 } })).json()).toMatchObject({ enabled: false, order: 5 });
    expect((await ctx.as(admin, { method: 'DELETE', url: `/api/settings/redaction-rules/${jwt.id}` })).statusCode).toBe(409);
    expect((await ctx.as(admin, { method: 'DELETE', url: `/api/settings/redaction-rules/${rule.id}` })).statusCode).toBe(204);

    await ctx.s.auditStore.flush();
    const now = Date.now();
    const evs = (await ctx.as(auditor, { method: 'GET', url: `/api/audit/events?from=${new Date(now - 60_000).toISOString()}&to=${new Date(now + 60_000).toISOString()}&kind=admin` })).json().items.map((e: { adminAction: string }) => e.adminAction);
    expect(evs).toEqual(expect.arrayContaining(['redaction_rule.create', 'redaction_rule.update', 'redaction_rule.delete']));
  });

  it('sends a signed test event to the configured webhook', async () => {
    expect((await ctx.as(admin, { method: 'POST', url: '/api/settings/export/test' })).statusCode).toBe(422);
    const patched = await ctx.as(admin, { method: 'PATCH', url: '/api/settings', payload: { export: { webhookUrl: 'https://siem.example.com/hook', webhookSecret: 'whsec-0123456789abcdef', webhookEnabled: true } } });
    expect(patched.statusCode, patched.body).toBe(200);
    const ok = await ctx.as(admin, { method: 'POST', url: '/api/settings/export/test' });

    expect(ok.json()).toEqual({ ok: true, status: 202, error: null });
    expect(posts[0]!.url).toBe('https://siem.example.com/hook');
    expect(verifyWebhookSignature('whsec-0123456789abcdef', posts[0]!.body, posts[0]!.headers['x-neurouter-signature']!, Date.now())).toBe(true);
    await ctx.as(admin, { method: 'PATCH', url: '/api/settings', payload: { export: { webhookUrl: 'https://fail.example.com/hook' } } });
    expect((await ctx.as(admin, { method: 'POST', url: '/api/settings/export/test' })).json()).toMatchObject({ ok: false, status: 500 });
    // the sink dispatcher delivers audit rows to the enabled webhook
    await ctx.as(admin, { method: 'PATCH', url: '/api/settings', payload: { export: { webhookUrl: 'https://siem.example.com/hook' } } });
    await ctx.s.auditStore.flush();
    posts.length = 0;
    const res = await ctx.s.sinkDispatcher.runOnce();
    expect(res.webhook!.delivered).toBeGreaterThan(0);
    expect(posts[0]!.body.split('\n')[0]).toContain('"type":"event"');
  });
});
