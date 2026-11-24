import { columnTypes, inList, isBool, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Users, roles, groups, OIDC mappings, agents, API keys, web sessions (backend plan §4.2 Identity). */
export const m0001_identity: DialectMigration = {
  name: '0001_identity',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);

    await db.schema
      .createTable('users')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('email', T.text, (c) => c.notNull())
      .addColumn('name', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('oidc_issuer', T.text)
      .addColumn('oidc_subject', T.text)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'disabled'])))
      .addColumn('avatar_url', T.text)
      .addColumn('last_login_at', T.ts)
      .addColumn('preferences', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_users_email', ['email'])
      .addUniqueConstraint('uq_users_oidc', ['oidc_issuer', 'oidc_subject'])
      .execute();

    await db.schema
      .createTable('user_roles')
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('role', T.text, (c) => c.notNull().check(inList('role', ['admin', 'auditor'])))
      .addColumn('source', T.text, (c) => c.notNull().check(inList('source', ['local', 'oidc', 'bootstrap'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('created_by', T.id)
      .addPrimaryKeyConstraint('pk_user_roles', ['user_id', 'role'])
      .execute();

    await db.schema
      .createTable('groups')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('description', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('source', T.text, (c) => c.notNull().check(inList('source', ['local', 'oidc'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_groups_name', ['name'])
      .execute();

    await db.schema
      .createTable('group_claim_mappings')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('group_id', T.id, (c) => c.notNull().references('groups.id').onDelete('cascade'))
      .addColumn('claim', T.text, (c) => c.notNull())
      .addColumn('value', T.text, (c) => c.notNull())
      .addColumn('last_seen_at', T.ts)
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_group_claim_mappings', ['claim', 'value', 'group_id'])
      .execute();
    await db.schema.createIndex('ix_group_claim_mappings_claim_value').on('group_claim_mappings').columns(['claim', 'value']).execute();

    await db.schema
      .createTable('group_memberships')
      .addColumn('group_id', T.id, (c) => c.notNull().references('groups.id').onDelete('cascade'))
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('source', T.text, (c) => c.notNull().check(inList('source', ['local', 'oidc'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_group_memberships', ['group_id', 'user_id'])
      .execute();
    await db.schema.createIndex('ix_group_memberships_user').on('group_memberships').column('user_id').execute();

    // oauth_clients lives here (not in 0008) because agents.oauth_client_id references it and
    // Postgres needs the target table to exist when the FK is declared.
    await db.schema
      .createTable('oauth_clients')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('client_id', T.text, (c) => c.notNull())
      .addColumn('registration_type', T.text, (c) => c.notNull().check(inList('registration_type', ['cimd', 'dcr', 'preregistered'])))
      .addColumn('client_name', T.text, (c) => c.notNull())
      .addColumn('client_uri', T.text)
      .addColumn('logo_uri', T.text)
      .addColumn('redirect_uris', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('grant_types', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('response_types', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('token_endpoint_auth_method', T.text, (c) =>
        c.notNull().check(inList('token_endpoint_auth_method', ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'])),
      )
      .addColumn('client_secret_hash', T.blob)
      .addColumn('application_type', T.text, (c) => c.check(inList('application_type', ['native', 'web'])))
      .addColumn('metadata', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('metadata_fetched_at', T.ts)
      .addColumn('metadata_expires_at', T.ts)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'blocked'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_oauth_clients_client_id', ['client_id'])
      .execute();

    await db.schema
      .createTable('agents')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('owner_user_id', T.id, (c) => c.notNull().references('users.id'))
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('description', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['api', 'oauth_client'])))
      .addColumn('oauth_client_id', T.id, (c) => c.references('oauth_clients.id'))
      // Phase 2 hook (decision 40): always NULL in P1 (meta-tools); never exposed by the P1 API.
      .addColumn('exposure_mode', T.text, (c) => c.check(inList('exposure_mode', ['meta', 'list'])))
      .addColumn('narrowed', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('narrowed')))
      .addColumn('rate_limit', T.json)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'disabled', 'deleted'])))
      .addColumn('last_seen_at', T.ts)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_agents_owner_name', ['owner_user_id', 'name'])
      .execute();
    await db.schema.createIndex('ix_agents_oauth_client').on('agents').column('oauth_client_id').execute();

    await db.schema
      .createTable('api_keys')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('agent_id', T.id, (c) => c.notNull().references('agents.id').onDelete('cascade'))
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('key_id', T.text, (c) => c.notNull())
      .addColumn('secret_hash', T.blob, (c) => c.notNull())
      .addColumn('display_prefix', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts)
      .addColumn('last_used_at', T.ts)
      .addColumn('last_used_ip', T.text)
      .addColumn('revoked_at', T.ts)
      .addColumn('created_by', T.id, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_api_keys_key_id', ['key_id'])
      .execute();
    await db.schema.createIndex('ix_api_keys_agent').on('api_keys').column('agent_id').execute();

    await db.schema
      .createTable('web_sessions')
      .addColumn('id_hash', T.blob, (c) => c.primaryKey())
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('csrf_token', T.text, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('last_seen_at', T.ts, (c) => c.notNull())
      .addColumn('ip', T.text)
      .addColumn('user_agent', T.text)
      .addColumn('id_token_hint', T.text)
      .execute();
    await db.schema.createIndex('ix_web_sessions_user').on('web_sessions').column('user_id').execute();
    await db.schema.createIndex('ix_web_sessions_expires').on('web_sessions').column('expires_at').execute();

    await db.schema
      .createTable('oidc_login_states')
      .addColumn('state_hash', T.blob, (c) => c.primaryKey())
      .addColumn('code_verifier_enc', T.blob, (c) => c.notNull())
      .addColumn('nonce', T.text, (c) => c.notNull())
      .addColumn('return_to', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await dropTables(db, ['oidc_login_states', 'web_sessions', 'api_keys', 'agents', 'oauth_clients', 'group_memberships', 'group_claim_mappings', 'groups', 'user_roles', 'users']);
  },
};
