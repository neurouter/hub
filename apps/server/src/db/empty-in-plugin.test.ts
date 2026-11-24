import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EmptyInListPlugin } from './empty-in-plugin.js';
import { createSqliteKysely } from './sqlite.js';

interface DB {
  t: { id: string; n: number };
}

const pg = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
  plugins: [new EmptyInListPlugin()],
});

describe('EmptyInListPlugin', () => {
  it('rewrites empty in / not in lists for Postgres', () => {
    expect(pg.selectFrom('t').select('id').where('id', 'in', []).compile().sql).toBe('select "id" from "t" where 1 = 0');
    expect(pg.selectFrom('t').select('id').where('id', 'not in', []).compile().sql).toBe('select "id" from "t" where 1 = 1');
  });

  it('leaves non-empty lists and other operators alone', () => {
    const q = pg.selectFrom('t').select('id').where('id', 'in', ['a', 'b']).where('n', '=', 1).compile();
    expect(q.sql).toBe('select "id" from "t" where "id" in ($1, $2) and "n" = $3');
    expect(q.parameters).toEqual(['a', 'b', 1]);
  });

  it('returns no rows for an empty in list on SQLite', async () => {
    const database = new Database(':memory:');
    database.exec("create table t (id text, n integer); insert into t values ('a', 1)");
    const db = createSqliteKysely<DB>(database);
    expect(await db.selectFrom('t').select('id').where('id', 'in', []).execute()).toEqual([]);
    expect(await db.selectFrom('t').select('id').where('id', 'not in', []).execute()).toEqual([{ id: 'a' }]);
    await db.destroy();
  });
});
