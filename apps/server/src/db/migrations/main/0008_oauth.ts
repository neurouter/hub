import { columnTypes, inList } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/**
 * Gateway-as-OAuth-AS tables (§4.2 OAuth AS). `oauth_clients` is created in 0001 because
 * `agents` references it. `client_id` columns hold the `oauth_clients` row id (not the public
 * client_id, which may be a CIMD URL), so they are uuid on Postgres like every other id.
 */
export const m0008_oauth: DialectMigration = {
  name: '0008_oauth',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);

    await db.schema
      .createTable('oauth_authz_requests')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('client_id', T.id, (c) => c.notNull())
      .addColumn('params', T.json, (c) => c.notNull())
      .addColumn('user_id', T.id)
      .addColumn('csrf_token', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('oauth_consents')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('client_id', T.id, (c) => c.notNull())
      .addColumn('agent_id', T.id, (c) => c.notNull())
      .addColumn('scopes', T.text, (c) => c.notNull())
      .addColumn('redirect_uri', T.text, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('revoked_at', T.ts)
      .addUniqueConstraint('uq_oauth_consents', ['user_id', 'client_id', 'redirect_uri'])
      .execute();

    await db.schema
      .createTable('oauth_codes')
      .addColumn('code_hash', T.blob, (c) => c.primaryKey())
      .addColumn('client_id', T.id, (c) => c.notNull())
      .addColumn('user_id', T.id, (c) => c.notNull())
      .addColumn('agent_id', T.id, (c) => c.notNull())
      .addColumn('redirect_uri', T.text, (c) => c.notNull())
      .addColumn('code_challenge', T.text, (c) => c.notNull())
      .addColumn('scopes', T.text, (c) => c.notNull())
      .addColumn('resource', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('consumed_at', T.ts)
      .execute();

    await db.schema
      .createTable('oauth_tokens')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('token_hash', T.blob, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['access', 'refresh'])))
      .addColumn('client_id', T.id, (c) => c.notNull())
      .addColumn('user_id', T.id, (c) => c.notNull())
      .addColumn('agent_id', T.id, (c) => c.notNull())
      .addColumn('scopes', T.text, (c) => c.notNull())
      .addColumn('resource', T.text, (c) => c.notNull())
      .addColumn('family_id', T.id, (c) => c.notNull())
      .addColumn('parent_id', T.id)
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('revoked_at', T.ts)
      .addColumn('last_used_at', T.ts)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_oauth_tokens_hash', ['token_hash'])
      .execute();
    await db.schema.createIndex('ix_oauth_tokens_family').on('oauth_tokens').column('family_id').execute();
    await db.schema.createIndex('ix_oauth_tokens_user').on('oauth_tokens').column('user_id').execute();
    await db.schema.createIndex('ix_oauth_tokens_expires').on('oauth_tokens').column('expires_at').execute();
  },
  async down(db) {
    await dropTables(db, ['oauth_tokens', 'oauth_codes', 'oauth_consents', 'oauth_authz_requests']);
  },
};
