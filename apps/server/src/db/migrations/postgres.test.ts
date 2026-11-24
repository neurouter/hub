import { describe, expect, it } from 'vitest';
import { recordingKysely } from '../../test/fakes/recording-dialect.js';
import { AUDIT_MIGRATIONS, MAIN_MIGRATIONS } from './index.js';
import { AUDIT_TABLE_COLUMNS, MAIN_TABLE_COLUMNS, POSTGRES_ONLY_COLUMNS } from '../schema.js';

/** Postgres paths compiled against a recording driver (no database needed). */
async function compileAll(dialect: 'postgres' | 'sqlite') {
  const { db, driver } = recordingKysely(dialect);
  for (const m of [...MAIN_MIGRATIONS, ...AUDIT_MIGRATIONS]) await m.up(db, { dialect, embeddingDims: 384 });
  return driver.sql();
}

function createTableSql(stmts: string[], table: string): string {
  const s = stmts.find((q) => q.startsWith(`create table "${table}" (`));
  if (!s) throw new Error(`no create table for ${table}`);
  return s;
}

describe('Postgres migrations (compiled)', () => {
  it('creates every inventory table with every column', async () => {
    const stmts = await compileAll('postgres');
    const inventory = { ...MAIN_TABLE_COLUMNS, ...AUDIT_TABLE_COLUMNS, } as Record<string, readonly string[]>;
    for (const [table, cols] of Object.entries(inventory)) {
      // later migrations add columns with ALTER TABLE
      const ddl = [createTableSql(stmts, table), ...stmts.filter((q) => q.startsWith(`alter table "${table}" add column `))].join('\n');
      for (const c of cols) expect(ddl, `${table}.${c}`).toContain(`"${c}" `);
    }
    for (const [table, cols] of Object.entries(POSTGRES_ONLY_COLUMNS)) {
      for (const c of cols) expect(createTableSql(stmts, table)).toContain(`"${c}" tsvector generated always as (`);
    }
  });

  it('adds approvals.api_key_id as a nullable uuid', async () => {
    const stmts = await compileAll('postgres');
    expect(stmts).toContain('alter table "approvals" add column "api_key_id" uuid');
  });

  it('uses portable Postgres types', async () => {
    const stmts = await compileAll('postgres');
    const users = createTableSql(stmts, 'users');
    expect(users).toContain('"id" uuid primary key');
    expect(users).toContain('"created_at" bigint not null');
    expect(users).toContain(`"preferences" jsonb default '{}' not null`);
    expect(createTableSql(stmts, 'api_keys')).toContain('"secret_hash" bytea not null');
    expect(createTableSql(stmts, 'agents')).toContain('"narrowed" smallint default 0 not null');
    expect(createTableSql(stmts, 'rate_limit_buckets')).toContain('"tokens" double precision not null');
    // rollup dimensions use '' for "none", so they must not be uuid
    expect(createTableSql(stmts, 'metric_rollups_1m')).toContain(`"server_id" text default '' not null`);
  });

  it('enables pgvector and uses a vector column', async () => {
    const stmts = await compileAll('postgres');
    expect(stmts).toContain('create extension if not exists vector');
    expect(createTableSql(stmts, 'tool_embeddings')).toContain('"embedding" vector(384) not null');
  });

  it('partitions audit_log by ts with a default partition and GIN FTS', async () => {
    const stmts = await compileAll('postgres');
    const audit = createTableSql(stmts, 'audit_log');
    expect(audit).toMatch(/\) partition by range \(ts\)$/);
    expect(audit).toContain('constraint "pk_audit_log" primary key ("seq", "ts")');
    expect(audit).toContain('constraint "uq_audit_log_id_ts" unique ("id", "ts")');
    expect(stmts).toContain('create table audit_log_default partition of audit_log default');
    expect(stmts).toContain('create index ix_audit_log_params_tsv on audit_log using gin (params_tsv)');
    expect(stmts).toContain('create index ix_tools_search_tsv on tools using gin (search_tsv)');
    expect(stmts.some((s) => s.includes('fts5'))).toBe(false);
  });

  it('encodes enum CHECKs including the `approved` audit decision', async () => {
    const stmts = await compileAll('postgres');
    expect(createTableSql(stmts, 'audit_log')).toContain(`'approved'`);
    expect(createTableSql(stmts, 'servers')).toContain(`check ("transport" in ('streamable_http', 'sse'))`);
  });

  it('rejects invalid embedding dimensions', async () => {
    const { db } = recordingKysely('postgres');
    const search = MAIN_MIGRATIONS.find((m) => m.name === '0006_search')!;
    await expect(search.up(db, { dialect: 'postgres', embeddingDims: 0 })).rejects.toThrow(/Invalid embedding dimensions/);
  });

  it('wraps a failing CREATE EXTENSION with the required DBA step', async () => {
    const { RecordingDriver } = await import('../../test/fakes/recording-dialect.js');
    const driver = new RecordingDriver((q) => {
      if (q.sql.includes('create extension')) throw new Error('permission denied to create extension "vector"');
      return { rows: [] };
    });
    const { db } = recordingKysely('postgres', driver);
    const search = MAIN_MIGRATIONS.find((m) => m.name === '0006_search')!;
    await expect(search.up(db, { dialect: 'postgres', embeddingDims: 384 })).rejects.toThrow(/CREATE EXTENSION vector/);
  });
});

describe('SQLite migrations (compiled)', () => {
  it('uses FTS5 instead of tsvector', async () => {
    const stmts = await compileAll('sqlite');
    expect(stmts.some((s) => s.includes('tsvector'))).toBe(false);
    expect(stmts.some((s) => s.startsWith('create virtual table tools_fts using fts5('))).toBe(true);
    expect(stmts.some((s) => s.startsWith('create virtual table audit_fts using fts5('))).toBe(true);
    expect(createTableSql(stmts, 'audit_log')).toContain('"seq" integer primary key');
  });
});
