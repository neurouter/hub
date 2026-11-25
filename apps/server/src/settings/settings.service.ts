import type { Kysely } from 'kysely';
import type { Role } from '@neurouter/shared';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';

export interface RoleMappingSetting {
  claim: string;
  value: string;
  role: Role;
}

/** Runtime settings stored in the `settings` table (backend §3.3) with their defaults. */
export interface SettingValues {
  auditRetentionDays: number;
  auditStoreFullOutput: boolean;
  auditFullOutputMaxBytes: number;
  approvalDefaultTimeoutSec: number;
  approvalMaxTimeoutSec: number;
  allowSelfApproval: boolean;
  rateLimitDefaults: { agentPerMinute: number; agentBurst: number; agentToolPerMinute: number; agentToolBurst: number; toolGlobalPerMinute: number | null };
  catalogVisibility: 'all' | 'granted';
  cimdPolicy: { mode: 'any' | 'allowlist'; allowedHosts: string[] };
  dcrEnabled: boolean;
  sessionIdleMinutes: number;
  metricsRetention: { minuteDays: number; hourDays: number };
  toolSyncDefaultIntervalMin: number;
  oidcRoleMappings: RoleMappingSetting[];
  auditSinks: { webhook: { url: string | null; secretRef: string | null; enabled: boolean }; otelLogs: { enabled: boolean } };
  /** Set once at first boot (audit genesis, HKDF salt). */
  installId: string | null;
  /** Block tool calls when audit events can't be queued (Q4: true). */
  auditFailClosed: boolean;
  /** Bounded audit FTS (approved addendum 4). */
  auditFtsEnabled: boolean;
  /** Param keys whose (redacted) values are full-text indexed; `*` = all keys. */
  auditSearchParamKeys: string[];
  /** Drop the `tool` label from /metrics for very large catalogs (§10.4). */
  metricsToolLabel: boolean;
  /** MCP server library: registry sync is off until an admin enables it (outbound requests). */
  librarySync: { enabled: boolean; registryUrl: string; githubTokenRef: string | null; autoCheck?: boolean };
}

export type SettingKey = keyof SettingValues;

export const SETTING_DEFAULTS: SettingValues = {
  auditRetentionDays: 90,
  auditStoreFullOutput: false,
  auditFullOutputMaxBytes: 65536,
  approvalDefaultTimeoutSec: 300,
  approvalMaxTimeoutSec: 900,
  allowSelfApproval: false,
  rateLimitDefaults: { agentPerMinute: 600, agentBurst: 120, agentToolPerMinute: 120, agentToolBurst: 30, toolGlobalPerMinute: null },
  catalogVisibility: 'all',
  cimdPolicy: { mode: 'any', allowedHosts: [] },
  dcrEnabled: true,
  sessionIdleMinutes: 30,
  metricsRetention: { minuteDays: 14, hourDays: 400 },
  toolSyncDefaultIntervalMin: 15,
  oidcRoleMappings: [],
  auditSinks: { webhook: { url: null, secretRef: null, enabled: false }, otelLogs: { enabled: false } },
  installId: null,
  auditFailClosed: true,
  auditFtsEnabled: true,
  auditSearchParamKeys: ['query', 'q', 'search', 'term', 'name', 'title', 'id', 'path', 'file', 'filename', 'url', 'repo', 'repository', 'owner', 'project', 'branch', 'issue', 'channel', 'table', 'database'],
  metricsToolLabel: true,
  librarySync: { enabled: false, registryUrl: 'https://registry.modelcontextprotocol.io', githubTokenRef: null },
};

export const SETTINGS_CHANNEL = 'settings.changed';

/** Typed access to DB settings with an in-process cache invalidated across replicas. */
export class SettingsService {
  private cache: Partial<SettingValues> | null = null;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord?: CoordinationStore,
  ) {
    coord?.subscribe(SETTINGS_CHANNEL, () => {
      this.cache = null;
    });
  }

  private async load(): Promise<Partial<SettingValues>> {
    if (this.cache) return this.cache;
    const rows = await this.db.selectFrom('settings').select(['key', 'value']).execute();
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = parseJsonColumn(r.value);
    this.cache = out as Partial<SettingValues>;
    return this.cache;
  }

  async get<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
    const all = await this.load();
    return (key in all ? all[key] : SETTING_DEFAULTS[key]) as SettingValues[K];
  }

  async has(key: SettingKey): Promise<boolean> {
    return key in (await this.load());
  }

  async set<K extends SettingKey>(key: K, value: SettingValues[K], updatedBy: string | null = null): Promise<void> {
    const now = this.clock.now();
    await this.db
      .insertInto('settings')
      .values({ key, value: toJsonColumn(value), updated_by: updatedBy, updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: toJsonColumn(value), updated_by: updatedBy, updated_at: now }))
      .execute();
    this.cache = null;
    await this.coord?.publish(SETTINGS_CHANNEL, { key });
  }

  /** Writes the value only when the key is absent (first-boot values shared by all replicas); returns the stored value. */
  async setIfAbsent<K extends SettingKey>(key: K, value: SettingValues[K]): Promise<SettingValues[K]> {
    await this.db
      .insertInto('settings')
      .values({ key, value: toJsonColumn(value), updated_by: null, updated_at: this.clock.now() })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
    this.cache = null;
    return this.get(key);
  }

  /** First boot: seed role mappings from OIDC_ADMIN_GROUPS / OIDC_AUDITOR_GROUPS (then DB-owned). */
  async seedRoleMappings(claim: string, adminGroups: readonly string[], auditorGroups: readonly string[]): Promise<boolean> {
    if (await this.has('oidcRoleMappings')) return false;
    const mappings: RoleMappingSetting[] = [
      ...adminGroups.map((value) => ({ claim, value, role: 'admin' as const })),
      ...auditorGroups.map((value) => ({ claim, value, role: 'auditor' as const })),
    ];
    await this.set('oidcRoleMappings', mappings);
    return true;
  }
}
