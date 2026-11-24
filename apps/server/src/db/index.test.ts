import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createDatabases, migrateAll, pingDatabase } from './index.js';
import { createPostgres, installPgTypeParsers, PG_INT8_OID, PG_JSON_OID, PG_JSONB_OID } from './postgres.js';
import { parseJsonColumn } from '../lib/json.js';
import { openSqlite } from './sqlite.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('createDatabases', () => {
  it('shares one handle when AUDIT_DATABASE_URL is unset', async () => {
    const dbs = createDatabases({ databaseUrl: 'sqlite::memory:' });
    expect(dbs.separateAudit).toBe(false);
    expect(dbs.audit.db).toBe(dbs.main.db);
    await dbs.close();
  });

  it('opens a separate audit database and migrates each set where it belongs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-db-'));
    dirs.push(dir);
    const dbs = createDatabases({ databaseUrl: `sqlite:${join(dir, 'main.db')}`, auditDatabaseUrl: `sqlite:${join(dir, 'audit.db')}` });
    expect(dbs.separateAudit).toBe(true);
    await migrateAll(dbs, { embeddingDims: 384 });
    const tables = (h: typeof dbs.main) =>
      h.native.kind === 'sqlite' ? (h.native.database.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name) : [];
    expect(tables(dbs.main)).toContain('users');
    expect(tables(dbs.main)).not.toContain('audit_log');
    expect(tables(dbs.audit as unknown as typeof dbs.main)).toContain('audit_log');
    expect(tables(dbs.audit as unknown as typeof dbs.main)).not.toContain('users');
    const ping = await pingDatabase(dbs.audit);
    expect(ping.ok).toBe(true);
    await dbs.close();
  });

  it('pings sqlite with versions', async () => {
    const dbs = createDatabases({ databaseUrl: 'sqlite::memory:' });
    const ping = await pingDatabase(dbs.main);
    expect(ping).toMatchObject({ ok: true });
    expect((ping as { version: string }).version).toMatch(/^sqlite 3\.\d+\.\d+, sqlite-vec v?\d/);
    await dbs.close();
  });
});

describe('openSqlite', () => {
  it('enables foreign keys and loads sqlite-vec', () => {
    const db = openSqlite({ filename: ':memory:' });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('select vec_version() as v').get()).toHaveProperty('v');
    db.close();
  });
});

describe('postgres handle (fake pool)', () => {
  it('builds a pool with the configured size and registers pgvector per connection', async () => {
    const listeners: Record<string, (arg: unknown) => void> = {};
    let config: pg.PoolConfig | undefined;
    const fakePool = {
      on: (ev: string, fn: (arg: unknown) => void) => { listeners[ev] = fn; return fakePool; },
      end: async () => {},
    };
    const warn = vi.fn();
    const handle = createPostgres<unknown>(
      { connectionString: 'postgres://u:p@h/db', max: 7 },
      { poolFactory: (c) => { config = c; return fakePool as unknown as pg.Pool; }, onWarn: warn },
    );
    expect(config).toMatchObject({ connectionString: 'postgres://u:p@h/db', max: 7, application_name: 'neurouter' });
    const setTypeParser = vi.fn();
    const client = { query: vi.fn(async () => ({ rows: [{ typname: 'vector', oid: 999 }] })), setTypeParser };
    listeners.connect?.(client);
    await vi.waitFor(() => expect(setTypeParser).toHaveBeenCalledWith(999, 'text', expect.any(Function)));

    // extension not created yet → silently skipped
    const bare = { query: vi.fn(async () => ({ rows: [] })), setTypeParser: vi.fn() };
    listeners.connect?.(bare);
    await new Promise((r) => setTimeout(r, 5));
    expect(warn).not.toHaveBeenCalled();
    expect(handle.db).toBeDefined();
  });

  it('parses int8 as Number', () => {
    const parsers = new Map<number, (v: string) => unknown>();
    installPgTypeParsers({ setTypeParser: ((oid: number, fn: (v: string) => unknown) => parsers.set(oid, fn)) as never });
    expect(parsers.get(PG_INT8_OID)?.('1732406400000')).toBe(1732406400000);
    // jsonb comes back as text so a JSON string value (e.g. a UUIDv7 installId) is parsed once
    for (const oid of [PG_JSON_OID, PG_JSONB_OID]) {
      const raw = parsers.get(oid)?.('"019abc00-0000-7000-8000-000000000000"');
      expect(raw).toBe('"019abc00-0000-7000-8000-000000000000"');
      expect(parseJsonColumn(raw)).toBe('019abc00-0000-7000-8000-000000000000');
    }
  });
});
