import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './load.js';
import { parseMasterKeys } from './env.js';

const key = () => randomBytes(32).toString('base64');
const prodEnv = () => ({
  NODE_ENV: 'production',
  PUBLIC_URL: 'https://mcp.acme.example',
  DATABASE_URL: 'postgres://u:p@db/n',
  NEUROUTER_MASTER_KEYS: `k1:${key()}`,
  NEUROUTER_ACTIVE_KEY_ID: 'k1',
  HASH_PEPPER: 'x'.repeat(40),
  OIDC_ISSUER: 'https://idp.example.com',
  OIDC_CLIENT_ID: 'client',
  OIDC_CLIENT_SECRET: 'secret',
});

describe('loadConfig', () => {
  it('applies development defaults with ephemeral keys and a warning', () => {
    const c = loadConfig({ NODE_ENV: 'development' });
    expect(c.env.PORT).toBe(3000);
    expect(c.publicUrl).toBe('http://localhost:3000');
    expect(c.resourceUri).toBe('http://localhost:3000/mcp');
    expect(c.dialect).toBe('sqlite');
    expect(c.auditDatabaseUrl).toBe(c.databaseUrl);
    expect(c.separateAuditDb).toBe(false);
    expect(c.masterKeys.get(c.activeKeyId)?.length).toBe(32);
    expect(c.warnings.join('\n')).toMatch(/ephemeral key/);
    expect(c.cookieNames.session).toBe('nr_session');
    expect(c.serveWeb).toBe(false);
    expect(c.env.EMBEDDINGS_DIMS).toBe(384);
  });

  it('parses booleans, CSV lists and numbers from strings', () => {
    const c = loadConfig({ NODE_ENV: 'test', LOG_PRETTY: 'true', OIDC_ADMIN_GROUPS: 'admins, ops ,', PORT: '4100', MIGRATE_ON_START: '0', PUBLIC_URL: '' });
    expect(c.env.LOG_PRETTY).toBe(true);
    expect(c.env.OIDC_ADMIN_GROUPS).toEqual(['admins', 'ops']);
    expect(c.env.PORT).toBe(4100);
    expect(c.env.MIGRATE_ON_START).toBe(false);
    expect(c.publicUrl).toBe('http://localhost:4100');
  });

  it('accepts a full production config and uses __Host- cookies', () => {
    const c = loadConfig(prodEnv());
    expect(c.isProduction).toBe(true);
    expect(c.dialect).toBe('postgres');
    expect(c.cookieNames).toEqual({ session: '__Host-nr_session', consent: '__Host-nr_consent' });
    expect(c.serveWeb).toBe(true);
    expect(c.warnings).toEqual([]);
  });

  it('supports a separate AUDIT_DATABASE_URL', () => {
    const c = loadConfig({ ...prodEnv(), AUDIT_DATABASE_URL: 'postgres://u:p@audit/n' });
    expect(c.separateAuditDb).toBe(true);
    expect(c.auditDatabaseUrl).toBe('postgres://u:p@audit/n');
  });

  it.each([
    [{ PUBLIC_URL: 'http://mcp.acme.example' }, /https in production/],
    [{ PUBLIC_URL: 'https://mcp.acme.example/' }, /trailing|slash/],
    [{ OIDC_CLIENT_SECRET: '' }, /OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET/],
    [{ AUTH_DEV_LOGIN: 'true' }, /AUTH_DEV_LOGIN is only allowed/],
    [{ HASH_PEPPER: 'short' }, /at least 32/],
    [{ NEUROUTER_MASTER_KEYS: 'k1:dG9vc2hvcnQ=' }, /32 bytes/],
    [{ NEUROUTER_ACTIVE_KEY_ID: 'k9' }, /must name one of/],
    [{ DATABASE_URL: 'mysql://x' }, /sqlite: or postgres/],
    [{ NEUROUTER_MASTER_KEYS: '' }, /NEUROUTER_MASTER_KEYS is required in production/],
  ])('rejects invalid production config %#', (patch, message) => {
    expect(() => loadConfig({ ...prodEnv(), ...patch })).toThrow(message);
  });

  it('lists every problem in ConfigError', () => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('parseMasterKeys', () => {
  it('parses several keys', () => {
    const keys = parseMasterKeys(`k1:${key()}, k2:${key()}`);
    expect([...keys.keys()]).toEqual(['k1', 'k2']);
  });
  it.each(['', 'nocolon', `bad id:${key()}`, `k1:${key()},k1:${key()}`])('rejects %j', (v) => {
    expect(() => parseMasterKeys(v)).toThrow();
  });
});
