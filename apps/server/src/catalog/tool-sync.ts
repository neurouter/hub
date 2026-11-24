import type { Kysely } from 'kysely';
import type { Tool } from '@modelcontextprotocol/client';
import type { AuditRecorder } from '../audit/recorder.js';
import type { Insertable } from 'kysely';
import type { MainDB, ToolsTable } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { toBool, toJsonColumn } from '../lib/json.js';
import type { UpstreamPool, UpstreamServer } from '../upstream/pool.js';
import { exposedNameFor } from './naming.js';
import { definitionOf, hashDefinition, invalidHeaderAnnotation, searchTextOf, type ToolDefinition } from './tool-hash.js';
import { ftsInsert, nextToolSeq, updateIndexedTool } from './tools.repo.js';

export interface SyncResult {
  runId: string;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  skipped: { name: string; reason: string }[];
}

export type SyncTrigger = 'schedule' | 'manual' | 'notification';

export class SyncError extends Error {
  constructor(message: string, readonly runId: string) {
    super(message);
    this.name = 'SyncError';
  }
}

/** Columns that mirror a definition (what the gateway serves once pinned). */
function columnsOf(def: ToolDefinition) {
  return {
    title: def.title,
    description: def.description,
    input_schema: toJsonColumn(def.inputSchema),
    output_schema: def.outputSchema ? toJsonColumn(def.outputSchema) : null,
    annotations: def.annotations ? toJsonColumn(def.annotations) : null,
    execution: def.execution ? toJsonColumn(def.execution) : null,
    search_text: searchTextOf(def),
  };
}

/**
 * Tool sync with definition pinning (backend §6): new tools → pending_review (or active with
 * auto-approve), a changed hash → `changed` (blocks calls until re-approved; auto-approve never
 * applies to changes), missing upstream → `removed`. The gateway always serves the pinned definition.
 */
export class ToolSyncService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly dialect: Dialect,
    private readonly clock: Clock,
    private readonly pool: UpstreamPool,
    private readonly audit: AuditRecorder,
    private readonly onChanged: () => Promise<void>,
  ) {}

  /** For per-user OAuth servers: the owner if connected, else the first connected user (Q7). */
  async syncUserFor(serverId: string, ownerId: string): Promise<string | null> {
    const owner = await this.db.selectFrom('user_upstream_tokens').select('user_id').where('server_id', '=', serverId).where('user_id', '=', ownerId).where('status', '=', 'active').executeTakeFirst();
    if (owner) return owner.user_id;
    const first = await this.db.selectFrom('user_upstream_tokens').select('user_id').where('server_id', '=', serverId).where('status', '=', 'active').orderBy('created_at').limit(1).executeTakeFirst();
    return first?.user_id ?? null;
  }

  async sync(serverId: string, trigger: SyncTrigger): Promise<SyncResult> {
    const server = await this.db.selectFrom('servers').selectAll().where('id', '=', serverId).executeTakeFirst();
    if (!server) throw new Error(`Server ${serverId} not found`);
    const runId = newId();
    const startedAt = this.clock.now();
    await this.db.insertInto('tool_sync_runs').values({ id: runId, server_id: serverId, trigger, started_at: startedAt, finished_at: null, status: 'running', error: null }).execute();
    const finish = async (status: 'ok' | 'error', r: Partial<SyncResult>, error: string | null) => {
      await this.db
        .updateTable('tool_sync_runs')
        .set({ status, finished_at: this.clock.now(), added: r.added ?? 0, changed: r.changed ?? 0, removed: r.removed ?? 0, unchanged: r.unchanged ?? 0, error })
        .where('id', '=', runId)
        .execute();
    };
    let tools: Tool[];
    try {
      const up: UpstreamServer = { id: server.id, name: server.name, url: server.url, transport: server.transport, authMode: server.auth_mode, timeoutMs: server.timeout_ms };
      const syncUser = server.auth_mode === 'user_oauth' ? await this.syncUserFor(server.id, server.owner_user_id) : null;
      if (server.auth_mode === 'user_oauth' && !syncUser) throw new Error('No connected user to sync with yet: the owner (or any user) must connect their account first');
      tools = (await this.pool.listTools(up, syncUser)).tools;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await finish('error', {}, msg);
      throw new SyncError(msg, runId);
    }

    const result: SyncResult = { runId, added: 0, changed: 0, removed: 0, unchanged: 0, skipped: [] };
    const now = this.clock.now();
    const autoApprove = toBool(server.auto_approve_new_tools);
    const changedTools: { id: string; name: string }[] = [];
    await this.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom('tools').selectAll().where('server_id', '=', serverId).execute();
      const byName = new Map(existing.map((t) => [t.upstream_name, t]));
      const seen = new Set<string>();
      let seq = await nextToolSeq(trx);
      for (const raw of tools) {
        if (seen.has(raw.name)) {
          result.skipped.push({ name: raw.name, reason: 'duplicate tool name' });
          continue;
        }
        const def = definitionOf(raw as never);
        const bad = invalidHeaderAnnotation(def.inputSchema);
        if (bad) {
          result.skipped.push({ name: raw.name, reason: bad });
          continue;
        }
        seen.add(raw.name);
        const hash = hashDefinition(def);
        const cur = byName.get(raw.name);
        if (!cur) {
          const id = newId();
          const exposed = exposedNameFor(server.slug, raw.name).name;
          const cols = columnsOf(def);
          const row: Insertable<ToolsTable> & { seq: number } = {
            id,
            server_id: serverId,
            seq: seq++,
            upstream_name: raw.name,
            exposed_name: exposed,
            ...cols,
            icons: null,
            pinned_hash: autoApprove ? hash : null,
            pending_hash: autoApprove ? null : hash,
            pending_definition: autoApprove ? null : toJsonColumn(def),
            status: autoApprove ? 'active' : 'pending_review',
            enabled: autoApprove ? (1 as const) : (0 as const),
            requires_approval: 0 as const,
            approval_timeout_sec: null,
            rate_limit: null,
            first_seen_at: now,
            last_seen_at: now,
            approved_by: null,
            approved_at: autoApprove ? now : null,
            created_at: now,
            updated_at: now,
          };
          await trx.insertInto('tools').values(row).execute();
          await ftsInsert(trx, this.dialect, { seq: row.seq, exposed_name: exposed, title: cols.title, description: cols.description, search_text: cols.search_text });
          await trx.insertInto('tool_versions').values({ id: newId(), tool_id: id, hash, definition: toJsonColumn(def), first_seen_at: now, decision: autoApprove ? 'approved' : 'pending', decided_by: null, decided_at: autoApprove ? now : null }).execute();
          result.added++;
          continue;
        }

        const base = { last_seen_at: now, updated_at: now };
        const supersedePending = () => trx.updateTable('tool_versions').set({ decision: 'superseded' }).where('tool_id', '=', cur.id).where('decision', '=', 'pending').execute();
        const addPendingVersion = () => trx.insertInto('tool_versions').values({ id: newId(), tool_id: cur.id, hash, definition: toJsonColumn(def), first_seen_at: now, decision: 'pending', decided_by: null, decided_at: null }).execute();

        if (cur.pinned_hash === hash) {
          // matches what is pinned; a change that was reverted upstream un-blocks the tool
          if (cur.status === 'changed' || cur.status === 'removed' || cur.status === 'rejected') {
            await supersedePending();
            await trx.updateTable('tools').set({ ...base, status: 'active', pending_hash: null, pending_definition: null }).where('id', '=', cur.id).execute();
          } else {
            await trx.updateTable('tools').set(base).where('id', '=', cur.id).execute();
          }
          result.unchanged++;
        } else if (cur.pending_hash === hash) {
          // the same unreviewed definition again
          const status = cur.status === 'removed' ? (cur.pinned_hash ? 'changed' : 'pending_review') : cur.status;
          await trx.updateTable('tools').set({ ...base, status }).where('id', '=', cur.id).execute();
          result.unchanged++;
        } else {
          await supersedePending();
          await addPendingVersion();
          if (cur.pinned_hash === null) {
            // never approved: show the newest definition for review
            await updateIndexedTool(trx, this.dialect, cur, { ...base, ...columnsOf(def), status: 'pending_review' as const, pending_hash: hash, pending_definition: toJsonColumn(def) });
            result.added++;
          } else {
            // rug-pull protection: block until re-approved; pinned columns stay as they are
            await trx.updateTable('tools').set({ ...base, status: 'changed', pending_hash: hash, pending_definition: toJsonColumn(def) }).where('id', '=', cur.id).execute();
            changedTools.push({ id: cur.id, name: cur.exposed_name });
            result.changed++;
          }
        }
      }
      for (const t of existing) {
        if (!seen.has(t.upstream_name) && t.status !== 'removed') {
          await trx.updateTable('tools').set({ status: 'removed', updated_at: now }).where('id', '=', t.id).execute();
          result.removed++;
        }
      }
      await trx.updateTable('servers').set({ last_synced_at: now, updated_at: now, ...(server.status === 'error' ? { status: 'active' } : {}) }).where('id', '=', serverId).execute();
    });
    await finish('ok', result, result.skipped.length ? `skipped: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`.slice(0, 1000) : null);
    for (const t of changedTools) this.audit.system('tool.definition_changed', { targetType: 'tool', targetId: t.id, reason: t.name });
    if (result.added || result.changed || result.removed) await this.onChanged();
    return result;
  }
}

export { toBool };
