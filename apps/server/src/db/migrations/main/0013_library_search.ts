import { sql } from 'kysely';
import type { DialectMigration } from '../types.js';

/**
 * Library search: index names without the `io.github.` prefix. More than half of all registry
 * names start with it, so a search for "github" matched nearly every GitHub-published server.
 * The namespace in `search_text` keeps only the account name for the same reason.
 */
export const m0013_library_search: DialectMigration = {
  name: '0013_library_search',
  async up(db, { dialect }) {
    await sql`update library_entries set search_text = replace(search_text, 'io.github.', '')`.execute(db);
    if (dialect === 'postgres') {
      await sql`drop index if exists ix_library_entries_search_tsv`.execute(db);
      await sql`alter table library_entries drop column search_tsv`.execute(db);
      await sql`alter table library_entries add column search_tsv tsvector generated always as (setweight(to_tsvector('simple'::regconfig, regexp_replace(coalesce(name, ''), '^io\\.github\\.', '') || ' ' || coalesce(title, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce(search_text, '')), 'C')) stored`.execute(db);
      await sql`create index ix_library_entries_search_tsv on library_entries using gin (search_tsv)`.execute(db);
    } else {
      await sql`delete from library_fts`.execute(db);
      await sql`insert into library_fts(entry_id, name, title, description, search_text) select id, case when name like 'io.github.%' then substr(name, 11) else name end, coalesce(title, ''), description, search_text from library_entries`.execute(db);
    }
  },
  async down() {
    // forward-only (the index content is derived)
  },
};
