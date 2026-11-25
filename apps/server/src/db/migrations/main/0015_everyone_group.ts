import { sql } from 'kysely';
import { EVERYONE_GROUP_ID } from '@neurouter/shared';
import type { DialectMigration } from '../types.js';

/** The built-in Everyone group (implicit membership; see EVERYONE_GROUP_ID). */
export const m0015_everyone_group: DialectMigration = {
  name: '0015_everyone_group',
  async up(db) {
    const taken = await sql<{ id: string }>`select id from groups where lower(name) = 'everyone'`.execute(db);
    const name = taken.rows.length ? 'Everyone (all users)' : 'Everyone';
    const now = Date.now();
    await sql`insert into groups (id, name, description, source, created_at, updated_at) values (${EVERYONE_GROUP_ID}, ${name}, ${'Every user in the organization. Grant a server to this group to make it available to everyone.'}, 'local', ${now}, ${now})`.execute(db);
  },
  async down(db) {
    await sql`delete from grants where subject_type = 'group' and subject_id = ${EVERYONE_GROUP_ID}`.execute(db);
    await sql`delete from groups where id = ${EVERYONE_GROUP_ID}`.execute(db);
  },
};
