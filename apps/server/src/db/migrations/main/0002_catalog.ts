import { sql, type CreateTableBuilder } from 'kysely';
import { columnTypes, inList, isBool, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Servers, icons, credentials, envelope-encryption keys, secrets, upstream tokens, tools, sync, health (§4.2 Catalog). */
export const m0002_catalog: DialectMigration = {
  name: '0002_catalog',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const pg = dialect === 'postgres';

    await db.schema
      .createTable('servers')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('slug', T.text, (c) => c.notNull())
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('owner_user_id', T.id, (c) => c.notNull().references('users.id'))
      .addColumn('description', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('url', T.text, (c) => c.notNull())
      // `stdio_managed` is reserved for Phase 2
      .addColumn('transport', T.text, (c) => c.notNull().check(inList('transport', ['streamable_http', 'sse'])))
      .addColumn('auth_mode', T.text, (c) => c.notNull().check(inList('auth_mode', ['none', 'shared', 'user_oauth'])))
      .addColumn('trusted', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('trusted')))
      .addColumn('enabled', T.bool, (c) => c.notNull().defaultTo(1).check(isBool('enabled')))
      .addColumn('tags', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('icon_url', T.text)
      .addColumn('timeout_ms', T.int, (c) => c.notNull().defaultTo(60000))
      .addColumn('sync_interval_min', T.int)
      .addColumn('auto_approve_new_tools', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('auto_approve_new_tools')))
      .addColumn('oauth_config', T.json)
      .addColumn('rate_limit', T.json)
      .addColumn('detected_era', T.text, (c) => c.check(inList('detected_era', ['modern', 'legacy', 'legacy_sse'])))
      .addColumn('protocol_version', T.text)
      .addColumn('server_info', T.json)
      .addColumn('capabilities', T.json)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'disabled', 'error'])))
      .addColumn('last_synced_at', T.ts)
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_servers_slug', ['slug'])
      .execute();
    await db.schema.createIndex('ix_servers_status').on('servers').column('status').execute();
    await db.schema.createIndex('ix_servers_owner').on('servers').column('owner_user_id').execute();

    await db.schema
      .createTable('server_icons')
      .addColumn('server_id', T.id, (c) => c.primaryKey().references('servers.id').onDelete('cascade'))
      .addColumn('source_url', T.text, (c) => c.notNull())
      .addColumn('content_type', T.text, (c) => c.check(inList('content_type', ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])))
      .addColumn('bytes', T.blob)
      .addColumn('etag', T.text)
      .addColumn('fetched_at', T.ts, (c) => c.notNull())
      .addColumn('error', T.text)
      .execute();

    await db.schema
      .createTable('encryption_keys')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('kek_id', T.text, (c) => c.notNull())
      .addColumn('wrapped_key', T.blob, (c) => c.notNull())
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['active', 'retired'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_encryption_keys_status').on('encryption_keys').column('status').execute();

    await db.schema
      .createTable('secrets')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('purpose', T.text, (c) => c.notNull())
      // `aws_sm` / `gcp_sm` / `vault` reserved
      .addColumn('provider', T.text, (c) => c.notNull().defaultTo('builtin').check(inList('provider', ['builtin'])))
      .addColumn('external_ref', T.text)
      .addColumn('dek_id', T.id, (c) => c.references('encryption_keys.id'))
      .addColumn('nonce', T.blob)
      .addColumn('ciphertext', T.blob)
      .addColumn('version', T.int, (c) => c.notNull().defaultTo(1))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_secrets_dek').on('secrets').column('dek_id').execute();

    await db.schema
      .createTable('server_credentials')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['shared_bearer', 'shared_header', 'oauth_client_secret'])))
      .addColumn('header_name', T.text)
      .addColumn('secret_id', T.id, (c) => c.notNull().references('secrets.id'))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addColumn('rotated_at', T.ts)
      .addUniqueConstraint('uq_server_credentials', ['server_id', 'kind'])
      .execute();

    await db.schema
      .createTable('user_upstream_tokens')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('issuer', T.text, (c) => c.notNull())
      .addColumn('dek_id', T.id, (c) => c.notNull().references('encryption_keys.id'))
      .addColumn('access_nonce', T.blob, (c) => c.notNull())
      .addColumn('access_ct', T.blob, (c) => c.notNull())
      .addColumn('refresh_nonce', T.blob)
      .addColumn('refresh_ct', T.blob)
      .addColumn('token_type', T.text, (c) => c.notNull().defaultTo('Bearer'))
      .addColumn('scopes', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('expires_at', T.ts)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'refresh_failed', 'revoked'])))
      .addColumn('refreshed_at', T.ts)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_user_upstream_tokens', ['user_id', 'server_id'])
      .execute();
    await db.schema.createIndex('ix_user_upstream_tokens_expires').on('user_upstream_tokens').column('expires_at').execute();

    await db.schema
      .createTable('upstream_oauth_states')
      .addColumn('state_hash', T.blob, (c) => c.primaryKey())
      .addColumn('user_id', T.id, (c) => c.notNull())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('issuer', T.text, (c) => c.notNull())
      .addColumn('code_verifier_enc', T.blob, (c) => c.notNull())
      .addColumn('redirect_after', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tools: CreateTableBuilder<any, any> = db.schema
      .createTable('tools')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('seq', T.bigint, (c) => c.notNull())
      .addColumn('upstream_name', T.text, (c) => c.notNull())
      .addColumn('exposed_name', T.text, (c) => c.notNull())
      .addColumn('title', T.text)
      .addColumn('description', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('input_schema', T.json, (c) => c.notNull())
      .addColumn('output_schema', T.json)
      .addColumn('annotations', T.json)
      .addColumn('icons', T.json)
      .addColumn('execution', T.json)
      .addColumn('pinned_hash', T.text)
      .addColumn('pending_hash', T.text)
      .addColumn('pending_definition', T.json)
      .addColumn('status', T.text, (c) =>
        c.notNull().check(inList('status', ['pending_review', 'active', 'changed', 'removed', 'rejected'])),
      )
      .addColumn('enabled', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('enabled')))
      .addColumn('requires_approval', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('requires_approval')))
      .addColumn('approval_timeout_sec', T.int)
      .addColumn('rate_limit', T.json)
      .addColumn('search_text', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('first_seen_at', T.ts, (c) => c.notNull())
      .addColumn('last_seen_at', T.ts, (c) => c.notNull())
      .addColumn('approved_by', T.id)
      .addColumn('approved_at', T.ts)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_tools_server_upstream', ['server_id', 'upstream_name'])
      .addUniqueConstraint('uq_tools_exposed_name', ['exposed_name'])
      .addUniqueConstraint('uq_tools_seq', ['seq']);
    if (pg) {
      // Keyword index for Postgres (SQLite uses the tools_fts FTS5 table from 0006_search).
      tools = tools.addColumn('search_tsv', sql`tsvector`, (c) =>
        c
          .generatedAlwaysAs(
            sql`setweight(to_tsvector('simple'::regconfig, coalesce(exposed_name, '') || ' ' || coalesce(title, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce(search_text, '')), 'C')`,
          )
          .stored(),
      );
    }
    await tools.execute();
    await db.schema.createIndex('ix_tools_status_enabled').on('tools').columns(['status', 'enabled']).execute();
    if (pg) await sql`create index ix_tools_search_tsv on tools using gin (search_tsv)`.execute(db);

    await db.schema
      .createTable('tool_versions')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tool_id', T.id, (c) => c.notNull().references('tools.id').onDelete('cascade'))
      .addColumn('hash', T.text, (c) => c.notNull())
      .addColumn('definition', T.json, (c) => c.notNull())
      .addColumn('first_seen_at', T.ts, (c) => c.notNull())
      .addColumn('decision', T.text, (c) => c.notNull().check(inList('decision', ['pending', 'approved', 'rejected', 'superseded'])))
      .addColumn('decided_by', T.id)
      .addColumn('decided_at', T.ts)
      .execute();
    await db.schema.createIndex('ix_tool_versions_tool_seen').on('tool_versions').columns(['tool_id', 'first_seen_at']).execute();

    await db.schema
      .createTable('tool_sync_runs')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('trigger', T.text, (c) => c.notNull().check(inList('trigger', ['schedule', 'manual', 'notification'])))
      .addColumn('started_at', T.ts, (c) => c.notNull())
      .addColumn('finished_at', T.ts)
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['running', 'ok', 'error'])))
      .addColumn('added', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('changed', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('removed', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('unchanged', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('error', T.text)
      .execute();
    await db.schema.createIndex('ix_tool_sync_runs_server_started').on('tool_sync_runs').columns(['server_id', 'started_at']).execute();

    await db.schema
      .createTable('server_health')
      .addColumn('server_id', T.id, (c) => c.primaryKey().references('servers.id').onDelete('cascade'))
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['up', 'degraded', 'down', 'unknown'])))
      .addColumn('latency_ms', T.int)
      .addColumn('checked_at', T.ts)
      .addColumn('error', T.text)
      .addColumn('consecutive_failures', T.int, (c) => c.notNull().defaultTo(0))
      .execute();

    await db.schema
      .createTable('server_health_checks')
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('checked_at', T.ts, (c) => c.notNull())
      .addColumn('ok', T.bool, (c) => c.notNull().check(isBool('ok')))
      .addColumn('latency_ms', T.int)
      .addPrimaryKeyConstraint('pk_server_health_checks', ['server_id', 'checked_at'])
      .execute();
  },
  async down(db) {
    await dropTables(db, [
      'server_health_checks', 'server_health', 'tool_sync_runs', 'tool_versions', 'tools', 'upstream_oauth_states',
      'user_upstream_tokens', 'server_credentials', 'secrets', 'encryption_keys', 'server_icons', 'servers',
    ]);
  },
};
