import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { sql, type Kysely } from 'kysely';
import { createDatabases, migrateAll, type Databases } from './index.js';
import { migrateDown, migrationStatus } from './migrator.js';
import { AUDIT_TABLE_COLUMNS, MAIN_TABLE_COLUMNS, SQLITE_ONLY_TABLES } from './schema.js';
import { createTestDatabases, TEST_EMBEDDING_DIMS } from '../test/fakes/test-db.js';

function sqliteOf(dbs: Databases): Database.Database {
  if (dbs.main.native.kind !== 'sqlite') throw new Error('expected sqlite');
  return dbs.main.native.database;
}

function userTables(database: Database.Database): string[] {
  const rows = database.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[];
  return rows
    .map((r) => r.name)
    .filter((n) => !n.startsWith('kysely_'))
    .filter((n) => !/_(data|idx|content|docsize|config)$/.test(n)) // FTS5 shadow tables
    .sort();
}

describe('schema drift (SQLite)', () => {
  let dbs: Databases | undefined;
  afterEach(async () => {
    await dbs?.close();
    dbs = undefined;
  });

  it('migrated tables and columns match schema.ts exactly', async () => {
    dbs = await createTestDatabases();
    const database = sqliteOf(dbs);
    const inventory = { ...MAIN_TABLE_COLUMNS, ...AUDIT_TABLE_COLUMNS } as Record<string, readonly string[]>;
    expect(userTables(database)).toEqual([...Object.keys(inventory), ...SQLITE_ONLY_TABLES].sort());
    for (const [table, columns] of Object.entries(inventory)) {
      const actual = (database.prepare(`pragma table_info(${JSON.stringify(table)})`).all() as { name: string }[]).map((c) => c.name);
      expect(actual.sort(), table).toEqual([...columns].sort());
    }
  });

  it('enforces CHECK constraints and foreign keys', async () => {
    dbs = await createTestDatabases();
    const db = dbs.main.db;
    const now = Date.now();
    await db.insertInto('users').values({ id: 'u1', email: 'a@example.com', created_at: now, updated_at: now }).execute();
    await expect(
      db.insertInto('users').values({ id: 'u2', email: 'b@example.com', status: 'nope' as 'active', created_at: now, updated_at: now }).execute(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.insertInto('user_roles').values({ user_id: 'missing', role: 'admin', source: 'local', created_at: now }).execute(),
    ).rejects.toThrow(/FOREIGN KEY/);
    const row = await db.selectFrom('users').select(['status', 'preferences', 'name']).where('id', '=', 'u1').executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'active', preferences: '{}', name: '' });
  });

  it('accepts the `approved` audit decision and rejects unknown ones', async () => {
    dbs = await createTestDatabases();
    const base = { id: 'a1', seq: 1, ts: 1, kind: 'tool_call' as const, decision: 'approved' as const, status: 'ok' as const, prev_hash: '0', hash: '1' };
    await dbs.audit.db.insertInto('audit_log').values(base).execute();
    await expect(dbs.audit.db.insertInto('audit_log').values({ ...base, id: 'a2', seq: 2, decision: 'bogus' as 'approved' }).execute()).rejects.toThrow(/CHECK/);
  });

  it('has working FTS5 and sqlite-vec', async () => {
    dbs = await createTestDatabases();
    const db = dbs.main.db as Kysely<unknown>;
    await sql`insert into tools_fts(rowid, exposed_name, title, description, search_text) values (1, 'github__create_issue', 'Create issue', 'Open a GitHub issue', 'title body')`.execute(db);
    const hits = await sql<{ rowid: number }>`select rowid from tools_fts where tools_fts match 'issue'`.execute(db);
    expect(hits.rows).toEqual([{ rowid: 1 }]);
    const v = await sql<{ d: number }>`select vec_distance_cosine(vec_f32('[1,0,0]'), vec_f32('[1,0,0]')) as d`.execute(db);
    expect(v.rows[0]?.d).toBeCloseTo(0);
  });

  it('down migrations remove every table (dev only)', async () => {
    dbs = await createTestDatabases();
    const ctx = { dialect: 'sqlite' as const, embeddingDims: TEST_EMBEDDING_DIMS };
    for (const set of ['audit', 'main'] as const) {
      const handle = set === 'main' ? dbs.main.db : dbs.audit.db;
      const count = (await migrationStatus(handle as Kysely<unknown>, set, ctx)).length;
      for (let i = 0; i < count; i++) await migrateDown(handle as Kysely<unknown>, set, ctx);
      expect((await migrationStatus(handle as Kysely<unknown>, set, ctx)).every((m) => m.executedAt === null)).toBe(true);
    }
    expect(userTables(sqliteOf(dbs))).toEqual([]);
  });

  it('is idempotent and tracks main and audit sets separately', async () => {
    dbs = createDatabases({ databaseUrl: 'sqlite::memory:' });
    const first = await migrateAll(dbs, { embeddingDims: TEST_EMBEDDING_DIMS });
    expect(first.main).toEqual(['0001_identity', '0002_catalog', '0003_policy', '0006_search', '0007_approvals', '0008_oauth', '0009_coordination', '0010_approval_api_key', '0011_pinning_mode', '0012_library', '0013_library_search', '0014_library_icons', '0015_everyone_group']);
    expect(first.audit).toEqual(['0004_audit', '0005_observability']);
    expect(await migrateAll(dbs, { embeddingDims: TEST_EMBEDDING_DIMS })).toEqual({ main: [], audit: [] });
    const tables = userTables(sqliteOf(dbs));
    expect(tables).toContain('audit_log');
  });
});
