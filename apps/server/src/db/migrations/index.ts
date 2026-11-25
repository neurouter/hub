import { m0001_identity } from './main/0001_identity.js';
import { m0002_catalog } from './main/0002_catalog.js';
import { m0003_policy } from './main/0003_policy.js';
import { m0006_search } from './main/0006_search.js';
import { m0007_approvals } from './main/0007_approvals.js';
import { m0008_oauth } from './main/0008_oauth.js';
import { m0009_coordination } from './main/0009_coordination.js';
import { m0010_approval_api_key } from './main/0010_approval_api_key.js';
import { m0011_pinning_mode } from './main/0011_pinning_mode.js';
import { m0012_library } from './main/0012_library.js';
import { m0013_library_search } from './main/0013_library_search.js';
import { m0014_library_icons } from './main/0014_library_icons.js';
import { m0015_everyone_group } from './main/0015_everyone_group.js';
import { m0004_audit } from './audit/0004_audit.js';
import { m0005_observability } from './audit/0005_observability.js';
import type { DialectMigration } from './types.js';

/**
 * Static migration sets (bundler-safe, explicit order; backend plan §4.3). Numbering follows the
 * plan; audit/observability migrations run against the audit database (approved addendum 2)
 * and are tracked in their own Kysely migration table.
 */
export const MAIN_MIGRATIONS: readonly DialectMigration[] = [
  m0001_identity,
  m0002_catalog,
  m0003_policy,
  m0006_search,
  m0007_approvals,
  m0008_oauth,
  m0009_coordination,
  m0010_approval_api_key,
  m0011_pinning_mode,
  m0012_library,
  m0013_library_search,
  m0014_library_icons,
  m0015_everyone_group,
];

export const AUDIT_MIGRATIONS: readonly DialectMigration[] = [m0004_audit, m0005_observability];

export type MigrationSet = 'main' | 'audit';

export const MIGRATION_TABLES: Record<MigrationSet, { table: string; lock: string }> = {
  main: { table: 'kysely_migration', lock: 'kysely_migration_lock' },
  audit: { table: 'kysely_audit_migration', lock: 'kysely_audit_migration_lock' },
};
