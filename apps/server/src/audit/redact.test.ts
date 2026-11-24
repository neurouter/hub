import { describe, expect, it } from 'vitest';
import { BUILTIN_RULES, checkPattern, luhnValid, MAX_ARRAY_ITEMS, paramsText, Redactor, type RedactionRuleDef } from './redact.js';

const r = Redactor.builtins();
const red = (v: unknown) => r.redact(v).value;

describe('redaction (built-in rules)', () => {
  it.each([
    ['password', 'hunter2'],
    ['apiKey', 'abc'],
    ['api_key', 'abc'],
    ['Authorization', 'Bearer x'],
    ['client_secret', 's'],
    ['sessionToken', 't'],
    ['privateKey', 'k'],
    ['cvv', '123'],
    ['IBAN', 'DE00'],
  ])('key %s → marker', (key, value) => {
    expect(red({ [key]: value, keep: 'ok' })).toEqual({ [key]: { $redacted: 'sensitive-key' }, keep: 'ok' });
  });

  it('redacts nested keys and whole objects under a sensitive key', () => {
    expect(red({ a: { b: [{ token: 'x', n: 1 }] }, credentials: { user: 'u', pass: 'p' } })).toEqual({ a: { b: [{ token: { $redacted: 'sensitive-key' }, n: 1 }] }, credentials: { $redacted: 'sensitive-key' } });
  });

  it.each([
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_-abc'],
    ['bearer-token', 'Bearer abc.def'],
    ['aws-access-key', ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')],
    ['github-token', `ghp_${'a'.repeat(36)}`],
    ['slack-token', 'xoxb-1234567890-abcdef'],
    ['neurouter-token', 'nr_live_0123456789_secretsecret'],
    ['credit-card', '4111 1111 1111 1111'],
    ['pem-block', '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'],
  ])('value rule %s: whole-string match → marker, partial → inline token', (rule, secret) => {
    expect(red({ v: secret })).toEqual({ v: { $redacted: rule } });
    expect(red({ v: `before ${secret} after` })).toEqual({ v: `before [REDACTED:${rule}] after` });
  });

  it('credit cards must pass Luhn; email is a disabled built-in', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(red({ v: '4111 1111 1111 1112' })).toEqual({ v: '4111 1111 1111 1112' });
    expect(red({ v: 'mail me: a@b.co' })).toEqual({ v: 'mail me: a@b.co' });
    const withEmail = new Redactor(BUILTIN_RULES.map((x, i) => ({ ...x, id: String(i), enabled: true })));
    expect(withEmail.redact({ v: 'a@b.co' }).value).toEqual({ v: { $redacted: 'email' } });
  });

  it('applies shape limits (4 KB strings, 200 items, depth 16)', () => {
    const out = red({ s: 'x'.repeat(5000), arr: Array.from({ length: 250 }, (_, i) => i) }) as { s: string; arr: unknown[] };
    expect(out.s).toMatch(/…\[truncated 904 bytes\]$/);
    expect(out.arr).toHaveLength(MAX_ARRAY_ITEMS + 1);
    expect(out.arr[MAX_ARRAY_ITEMS]).toBe('[truncated 50 items]');
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(red(deep))).toContain('[truncated: max depth]');
  });

  it('custom rules apply in order, first match wins, custom replacement used verbatim, matches reported', () => {
    const rules: RedactionRuleDef[] = [
      { id: 'r2', name: 'ticket', type: 'regex', pattern: 'TICKET-\\d+', replacement: '', enabled: true, order: 2, builtin: false },
      { id: 'r1', name: 'acct', type: 'regex', pattern: 'ACCT-\\d+', replacement: '***', enabled: true, order: 1, builtin: false },
      { id: 'r0', name: 'off', type: 'key', pattern: 'note', replacement: '', enabled: false, order: 0, builtin: false },
    ];
    const res = new Redactor(rules).redact({ a: 'ACCT-1 TICKET-2', note: 'visible' });
    expect(res.value).toEqual({ a: '*** TICKET-2', note: 'visible' });
    expect(res.matches).toEqual([{ path: ['a'], ruleId: 'r1' }]);
  });
});

describe('paramsText (bounded FTS)', () => {
  it('indexes allow-listed keys only and never redacted values', () => {
    const redacted = red({ query: 'quarterly report', token: 'secret-value', nested: { path: '/tmp/a', other: 'hidden' }, note: 'x Bearer abc y' });
    expect(paramsText(redacted, ['query', 'path', 'note'])).toBe('quarterly report /tmp/a x   y');
    expect(paramsText(redacted, ['*'])).not.toContain('secret-value');
    expect(paramsText(redacted, [])).toBeNull();
    expect(paramsText({ a: 1 }, ['b'])).toBeNull();
  });
});

describe('checkPattern', () => {
  it('rejects invalid and catastrophic patterns, accepts sane ones', () => {
    expect(checkPattern('regex', 'ACCT-\\d+')).toEqual({ ok: true });
    expect(checkPattern('regex', '(')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(checkPattern('regex', '^(a+)+$')).toMatchObject({ ok: false, reason: 'too_slow' });
  });
});
