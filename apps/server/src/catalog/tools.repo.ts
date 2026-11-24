import { sql, type Kysely, type Transaction } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Dialect } from '../db/url.js';

type Db = Kysely<MainDB> | Transaction<MainDB>;
type FtsRow = { seq: number; exposed_name: string; title: string | null; description: string; search_text: string };

/**
 * Keyword-index maintenance. SQLite keeps an external-content FTS5 table (`tools_fts`,
 * rowid = tools.seq) written in the same transaction as the tools row (no triggers, so the
 * write path is explicit). Postgres uses a generated tsvector column: nothing to do.
 */
export async function ftsDelete(db: Db, dialect: Dialect, row: FtsRow): Promise<void> {
  if (dialect !== 'sqlite') return;
  await sql`insert into tools_fts(tools_fts, rowid, exposed_name, title, description, search_text) values ('delete', ${row.seq}, ${row.exposed_name}, ${row.title ?? ''}, ${row.description}, ${row.search_text})`.execute(db);
}

export async function ftsInsert(db: Db, dialect: Dialect, row: FtsRow): Promise<void> {
  if (dialect !== 'sqlite') return;
  await sql`insert into tools_fts(rowid, exposed_name, title, description, search_text) values (${row.seq}, ${row.exposed_name}, ${row.title ?? ''}, ${row.description}, ${row.search_text})`.execute(db);
}

/** Next `tools.seq` (used as the FTS / vector rowid). Called inside the sync transaction. */
export async function nextToolSeq(db: Db): Promise<number> {
  const r = await db.selectFrom('tools').select(sql<number>`coalesce(max(seq), 0)`.as('m')).executeTakeFirst();
  return Number(r?.m ?? 0) + 1;
}

/** Updates indexed columns of a tool and keeps the FTS row in sync. */
export async function updateIndexedTool(
  db: Db,
  dialect: Dialect,
  before: FtsRow & { id: string },
  patch: { title?: string | null; description?: string; search_text?: string; exposed_name?: string; [k: string]: unknown },
): Promise<void> {
  const indexedChange = ['title', 'description', 'search_text', 'exposed_name'].some((k) => k in patch && patch[k] !== (before as Record<string, unknown>)[k]);
  if (indexedChange) await ftsDelete(db, dialect, before);
  await db.updateTable('tools').set(patch as never).where('id', '=', before.id).execute();
  if (indexedChange) {
    await ftsInsert(db, dialect, {
      seq: before.seq,
      exposed_name: (patch.exposed_name as string | undefined) ?? before.exposed_name,
      title: 'title' in patch ? (patch.title as string | null) : before.title,
      description: (patch.description as string | undefined) ?? before.description,
      search_text: (patch.search_text as string | undefined) ?? before.search_text,
    });
  }
}
