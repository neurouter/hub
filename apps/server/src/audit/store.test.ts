import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabases, type Databases } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { createTestDatabases } from '../test/fakes/test-db.js';
import { LocalFsArchive } from './archive/local-fs.js';
import type { ArchiveStore } from './archive/store.js';
import { auditMacKey } from './chain.js';
import { csvCell, csvHeader, csvLine } from './export.js';
import { SqlAuditStore, type SqlAuditStoreOptions } from './store.js';
import type { AuditEventInput } from './types.js';
import { DEFAULT_WRITE_CONTEXT } from './writer.js';

const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
const DAY = 86_400_000;

let dbs: Databases;
let now = T0;
const clock = { now: () => now };
const mac = { signer: () => ({ keyId: 'k1', key: auditMacKey(Buffer.alloc(32, 1)) }), keyFor: (k: string) => (k === 'k1' ? auditMacKey(Buffer.alloc(32, 1)) : null) };

function store(opts: Partial<SqlAuditStoreOptions> = {}) {
  return new SqlAuditStore(dbs.audit.db, dbs.audit.dialect, {
    clock,
    mac,
    context: async () => ({ ...DEFAULT_WRITE_CONTEXT, installId: 'test-install', searchParamKeys: ['query', 'path'] }),
    flushIntervalMs: 5,
    ...opts,
  });
}

let seq = 0;
function ev(over: Partial<AuditEventInput> = {}): AuditEventInput {
  seq++;
  return { id: newId(), ts: now + seq, kind: 'tool_call', decision: 'allowed', status: 'ok', userId: 'u1', agentId: 'a1', serverId: 's1', toolId: 't1', toolName: 'gh__list', latencyMs: 12, sessionKey: { source: 'idle_gap', externalKey: '' }, ...over };
}

beforeEach(async () => {
  now = T0;
  seq = 0;
  dbs = await createTestDatabases();
});
afterEach(async () => {
  await dbs.close();
});

describe('SqlAuditStore writer + chain', () => {
  it('batches, chains contiguously from genesis and verifies ok', async () => {
    const s = store();
    for (let i = 0; i < 450; i++) expect(s.record(ev())).toBe(true);
    await s.flush();
    expect(await s.headSeq()).toBe(450);
    const v = await s.verify({});
    expect(v).toMatchObject({ ok: true, checked: 450, firstSeq: 1, lastSeq: 450, brokenAt: null });
    expect(s.stats()).toEqual({ queueDepth: 0, dropped: 0, lastError: null });
    expect(await s.health()).toEqual({ ok: true });
    await s.close();
  });

  it('flushes on its own timer (200 ms default; 5 ms here)', async () => {
    const s = store();
    s.record(ev());
    await new Promise((r) => setTimeout(r, 50));
    expect(await s.headSeq()).toBe(1);
    await s.close();
  });

  it('redacts params before hashing; output stored as size + hash only by default', async () => {
    const s = store();
    s.record(ev({ params: { query: 'find report', password: 'hunter2' }, output: { content: [{ type: 'text', text: 'x' }] } }));
    await s.flush();
    const [row] = (await s.query({ from: T0, to: T0 + DAY, limit: 10 })).rows;
    expect(JSON.parse(row!.params_redacted!)).toEqual({ query: 'find report', password: { $redacted: 'sensitive-key' } });
    expect(row!.params_text).toBe('find report');
    expect(row!.output_size).toBe(JSON.stringify({ content: [{ type: 'text', text: 'x' }] }).length);
    expect(row!.output_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.output_full).toBeNull();
    expect(JSON.stringify(row)).not.toContain('hunter2');
  });

  it('verify points at an edited row (hash_mismatch) and a deleted middle row (gap)', async () => {
    const s = store();
    for (let i = 0; i < 10; i++) s.record(ev());
    await s.flush();
    await dbs.audit.db.updateTable('audit_log').set({ status: 'tool_error' }).where('seq', '=', 4).execute();
    expect((await s.verify({})).brokenAt).toMatchObject({ seq: 4, reason: 'hash_mismatch' });
    await dbs.audit.db.updateTable('audit_log').set({ status: 'ok' }).where('seq', '=', 4).execute();
    expect((await s.verify({})).ok).toBe(true);
    await dbs.audit.db.deleteFrom('audit_log').where('seq', '=', 6).execute();
    expect((await s.verify({})).brokenAt).toMatchObject({ seq: 6, reason: 'gap' });
  });

  it('detects a recomputed chain via checkpoint MACs, and tail deletion past a checkpoint', async () => {
    const s = store();
    for (let i = 0; i < 5; i++) s.record(ev());
    await s.flush();
    const cp = await s.checkpoint('periodic');
    expect(cp).toMatchObject({ seq: 5, kind: 'periodic', keyId: 'k1' });
    expect(await s.verify({})).toMatchObject({ ok: true, checkpointsVerified: 1 });
    await dbs.audit.db.updateTable('audit_checkpoints').set({ mac: 'f'.repeat(64) }).execute();
    expect((await s.verify({})).brokenAt).toMatchObject({ seq: 5, reason: 'bad_checkpoint_mac' });
    await dbs.audit.db.updateTable('audit_checkpoints').set({ mac: cp!.mac }).execute();
    await dbs.audit.db.deleteFrom('audit_log').where('seq', '>=', 4).execute();
    expect((await s.verify({})).brokenAt).toMatchObject({ reason: 'gap' });
  });

  it('periodic checkpoints every 10k rows or 5 minutes, only when the head moved', async () => {
    const s = store();
    expect(await s.periodicCheckpoint()).toBeNull();
    s.record(ev());
    await s.flush();
    expect(await s.periodicCheckpoint()).toMatchObject({ seq: 1 });
    expect(await s.periodicCheckpoint()).toBeNull();
    s.record(ev());
    await s.flush();
    expect(await s.periodicCheckpoint()).toBeNull();
    now += 5 * 60_000;
    expect(await s.periodicCheckpoint()).toMatchObject({ seq: 2 });
  });

  it('fails closed when the queue is full (and drops/counts when fail-open)', async () => {
    const closed = store({ queueMax: 3, flushIntervalMs: 60_000, batchMax: 100 });
    for (let i = 0; i < 3; i++) expect(closed.record(ev())).toBe(true);
    expect(closed.canAccept()).toBe(false);
    expect(closed.record(ev())).toBe(false);
    expect(closed.stats().dropped).toBe(1);
    await closed.flush();
    expect(closed.canAccept()).toBe(true);
    let fc = false;
    const open = store({ queueMax: 1, flushIntervalMs: 60_000, failClosed: () => fc });
    open.record(ev());
    expect(open.canAccept()).toBe(true);
    expect(open.record(ev())).toBe(true);
    expect(open.stats().dropped).toBe(1);
    fc = true;
    expect(open.canAccept()).toBe(false);
    await closed.close();
    await open.close();
  });

  it('re-queues a failed batch and reports unhealthy until it succeeds', async () => {
    let broken = true;
    const s = store({
      flushIntervalMs: 60_000,
      context: async () => {
        if (broken) throw new Error('settings unavailable');
        return { ...DEFAULT_WRITE_CONTEXT, installId: 'test-install' };
      },
    });
    s.record(ev());
    await s.flush();
    expect(s.stats()).toMatchObject({ queueDepth: 1, lastError: 'settings unavailable' });
    expect((await s.health()).ok).toBe(false);
    broken = false;
    await s.flush();
    expect(await s.headSeq()).toBe(1);
    expect(await s.health()).toEqual({ ok: true });
    await s.close();
  });

  it('calls onCommitted with the chained rows', async () => {
    const got: number[] = [];
    const s = store({ onCommitted: (rows) => got.push(...rows.map((r) => r.seq)) });
    s.record(ev());
    s.record(ev());
    await s.flush();
    expect(got).toEqual([1, 2]);
  });
});

describe('SqlAuditStore query', () => {
  it('requires to > from, filters, pages by seq desc, and searches bounded FTS', async () => {
    const s = store();
    s.record(ev({ params: { query: 'quarterly revenue', secret: 'revenue-secret' }, userId: 'u2' }));
    s.record(ev({ kind: 'admin', action: 'grant.create', decision: 'not_applicable', toolName: null, serverId: 's2', agentId: null }));
    s.record(ev({ decision: 'denied_acl', status: 'blocked', decisionReason: 'not_permitted_or_blocked', errorMessage: 'kaboom upstream' }));
    for (let i = 0; i < 5; i++) s.record(ev());
    await s.flush();
    await expect(s.query({ from: T0, to: T0, limit: 5 })).rejects.toMatchObject({ code: 'validation_failed' });
    const page1 = await s.query({ from: T0, to: T0 + DAY, limit: 3 });
    expect(page1.rows.map((r) => r.seq)).toEqual([8, 7, 6]);
    const page2 = await s.query({ from: T0, to: T0 + DAY, limit: 3, cursorSeq: page1.nextSeq });
    expect(page2.rows.map((r) => r.seq)).toEqual([5, 4, 3]);
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, serverIds: ['s2'] })).rows.map((r) => r.seq)).toEqual([2]);
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, serverIds: [] })).rows).toEqual([]);
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, decisions: ['denied_acl'] })).rows.map((r) => r.seq)).toEqual([3]);
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, userId: 'u2' })).rows.map((r) => r.seq)).toEqual([1]);
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, q: 'quarterly' })).rows.map((r) => r.seq)).toEqual([1]);
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, q: 'quart' })).rows.map((r) => r.seq)).toEqual([1]); // prefix
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, q: 'revenue-secret' })).rows).toEqual([]); // redacted → not findable
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, q: 'kaboom' })).rows.map((r) => r.seq)).toEqual([3]);
    expect((await s.query({ from: T0, to: T0 + DAY, limit: 50, q: '"); drop table audit_log; --' })).rows).toEqual([]);
    expect((await s.query({ from: T0 + DAY, to: T0 + 2 * DAY, limit: 50 })).rows).toEqual([]);
    expect(await s.count({ from: T0, to: T0 + DAY }, 5)).toBe(6);
    const all: number[] = [];
    for await (const r of s.export({ from: T0, to: T0 + DAY, order: 'asc' }, 4)) all.push(r.seq);
    expect(all).toEqual([1, 2, 3, 4]);
    expect(await s.decisionCounts({ from: T0, to: T0 + DAY, kinds: ['tool_call'] })).toEqual(expect.arrayContaining([{ decision: 'denied_acl', reason: 'not_permitted_or_blocked', count: 1 }]));
  });

  it('rejects q with 422 when FTS is disabled', async () => {
    const s = store({ ftsEnabled: () => false });
    await expect(s.query({ from: T0, to: T0 + DAY, limit: 5, q: 'x' })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('session derivation (inside the audit transaction)', () => {
  it('client id, trace id and legacy header group calls per agent; idle gap splits at the idle window', async () => {
    const s = store();
    s.record(ev({ sessionKey: { source: 'client', externalKey: 'abc' } }));
    s.record(ev({ sessionKey: { source: 'client', externalKey: 'abc' }, status: 'tool_error' }));
    s.record(ev({ sessionKey: { source: 'client', externalKey: 'abc' }, agentId: 'a2' })); // other agent: other session
    s.record(ev({ sessionKey: { source: 'trace', externalKey: '0af7651916cd43dd8448eb211c80319c' }, status: 'blocked', decision: 'denied_acl' }));
    s.record(ev({ sessionKey: { source: 'legacy', externalKey: 'L1' }, serverId: 's9' }));
    s.record(ev()); // idle gap
    s.record(ev({ ts: now + 20 * 60_000 })); // within 30 min → same idle session
    await s.flush();
    s.record(ev({ ts: now + 20 * 60_000 + 31 * 60_000 })); // > 30 min after the last call → new session
    s.record(ev({ kind: 'admin', agentId: null, decision: 'not_applicable', sessionKey: null }));
    await s.flush();
    const rows = (await s.query({ from: T0, to: T0 + DAY, limit: 50, order: 'asc' })).rows;
    const sid = rows.map((r) => r.session_id);
    expect(sid[0]).toBe(sid[1]);
    expect(sid[2]).not.toBe(sid[0]);
    expect(new Set([sid[0], sid[2], sid[3], sid[4], sid[5]]).size).toBe(5);
    expect(sid[6]).toBe(sid[5]);
    expect(sid[7]).not.toBe(sid[6]);
    expect(sid[8]).toBeNull();
    const sessions = await dbs.audit.db.selectFrom('mcp_sessions').selectAll().orderBy('first_seen_at').execute();
    expect(sessions).toHaveLength(6);
    const client = sessions.find((x) => x.source === 'client' && x.agent_id === 'a1')!;
    expect(client).toMatchObject({ external_key: 'abc', calls: 2, errors: 1, blocked: 0 });
    expect(sessions.find((x) => x.source === 'trace')).toMatchObject({ blocked: 1, calls: 1 });
    expect(JSON.parse(sessions.find((x) => x.source === 'legacy')!.servers as string)).toEqual(['s9']);
    const idle = sessions.filter((x) => x.source === 'idle_gap');
    expect(idle.map((x) => x.calls)).toEqual([2, 1]);
  });
});

describe('retention + archive', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function seed(s: SqlAuditStore) {
    // 3 rows on day 1, 2 rows on day 2, 2 rows today
    for (const [d, n] of [[-10, 3], [-9, 2], [0, 2]] as const) for (let i = 0; i < n; i++) s.record(ev({ ts: T0 + d * DAY + i, params: { query: `d${d}` } }));
    await s.flush();
  }

  it('cuts with a checkpoint, archives each day as gzip NDJSON + manifest, deletes, and verify stays ok', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nr-audit-'));
    const s = store({ archive: new LocalFsArchive(dir) });
    await seed(s);
    const out = await s.applyRetention(T0 - 5 * DAY);
    expect(out).toMatchObject({ cutSeq: 5, deleted: 5, archived: true, skipped: false });
    expect((await s.query({ from: T0 - 30 * DAY, to: T0 + DAY, limit: 50 })).rows.map((r) => r.seq)).toEqual([7, 6]);
    expect(await s.verify({})).toMatchObject({ ok: true, firstSeq: 6, lastSeq: 7 });
    // FTS rows were deleted with the data
    expect((await s.query({ from: T0 - 30 * DAY, to: T0 + DAY, limit: 50, q: 'd-10' })).rows).toEqual([]);
    const days = await readdir(join(dir, 'audit/2026/11'));
    expect(days.sort()).toEqual(['14', '15']);
    const files = (await readdir(join(dir, 'audit/2026/11/14'))).sort();
    expect(files).toEqual(['audit-2026-11-14-1-3.manifest.json', 'audit-2026-11-14-1-3.ndjson.gz']);
    const lines = gunzipSync(await readFile(join(dir, 'audit/2026/11/14', files[1]!))).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    const manifest = JSON.parse(await readFile(join(dir, 'audit/2026/11/14', files[0]!), 'utf8'));
    expect(manifest).toMatchObject({ format: 'ndjson+gzip', rows: 3, firstSeq: 1, lastSeq: 3, checkpoint: { seq: 5, kind: 'retention_cut', keyId: 'k1' } });
    // new rows keep chaining after the cut
    s.record(ev());
    await s.flush();
    expect(await s.verify({})).toMatchObject({ ok: true, checked: 3 });
  });

  it('skips the delete (and alerts) when archiving fails', async () => {
    const errors: string[] = [];
    const failing: ArchiveStore = { kind: 's3', location: 's3://x', put: async () => Promise.reject(new Error('denied')) };
    const s = store({ archive: failing, log: { info: () => {}, warn: () => {}, error: (_o, m) => errors.push(m) } });
    await seed(s);
    const out = await s.applyRetention(T0 - 5 * DAY);
    expect(out).toMatchObject({ skipped: true, deleted: 0, archived: false });
    expect(await s.headSeq()).toBe(7);
    expect(errors[0]).toMatch(/ALERT/);
    expect(await s.verify({})).toMatchObject({ ok: true, checked: 7, checkpointsVerified: 1 });
  });

  it('without archive: deletes old rows, prunes old sessions, no-op when nothing is due', async () => {
    const s = store();
    await seed(s);
    expect(await s.applyRetention(T0 - 30 * DAY)).toMatchObject({ cutSeq: null, deleted: 0 });
    const out = await s.applyRetention(T0 - 5 * DAY);
    expect(out).toMatchObject({ deleted: 5, archived: false });
    expect(out.sessionsDeleted).toBeGreaterThanOrEqual(1);
    expect((await s.verify({})).ok).toBe(true);
    // deleting the earliest retained row without a cut is detected
    await dbs.audit.db.deleteFrom('audit_log').where('seq', '=', 6).execute();
    expect((await s.verify({})).brokenAt).toMatchObject({ seq: 7, reason: 'broken_link' });
  });

  it('maps a time range to a seq range and reads rows after a cursor with checkpoints', async () => {
    const s = store();
    await seed(s);
    await s.checkpoint('periodic');
    expect(await s.seqRange(T0 - 9 * DAY, T0)).toEqual({ fromSeq: 4, toSeq: 5 });
    expect(await s.seqRange(T0 + DAY)).toBeNull();
    const r = await s.readAfter(4, 10);
    expect(r.rows.map((x) => x.seq)).toEqual([5, 6, 7]);
    expect(r.checkpoints.map((c) => c.seq)).toEqual([7]);
    expect(await s.maintainPartitions()).toEqual({ created: [], failed: [] });
  });
});

describe('export format', () => {
  it('escapes CSV (RFC 4180) and neutralizes formula injection', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvHeader().startsWith('seq,id,ts,kind,')).toBe(true);
  });

  it('writes one CSV line per row with ISO timestamps', async () => {
    const s = store();
    s.record(ev({ errorMessage: 'bad, "quoted"' }));
    await s.flush();
    const [row] = (await s.query({ from: T0, to: T0 + DAY, limit: 1 })).rows;
    const line = csvLine(row!);
    expect(line).toContain('2026-11-24T10:00:00.001Z');
    expect(line).toContain('"bad, ""quoted"""');
    expect(line.endsWith('\r\n')).toBe(true);
  });
});

describe('without migrations', () => {
  it('reports unhealthy', async () => {
    const raw = createDatabases({ databaseUrl: 'sqlite::memory:' });
    const res = await new SqlAuditStore(raw.audit.db, 'sqlite').health();
    expect(res.ok).toBe(false);
    await raw.close();
  });
});
