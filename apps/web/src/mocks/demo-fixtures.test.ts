import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS, buildPath, serializeQuery } from '@neurouter/shared';
import { demoFixtures } from './demo-fixtures';
import * as D from './demo-data';

const KEYS = new Set(ALL_ENDPOINTS.map((e) => e.key));

/** Sample params/query so every GET fixture can be exercised through the contract handlers. */
const PARAMS: Record<string, Record<string, string>> = {
  id: { id: D.SERVER_IDS.github },
};
const SAMPLE_ID: Record<string, string> = {
  users: D.PEOPLE.dana.id,
  groups: D.GROUPS.engineering.id,
  agents: D.AGENTS[0]!.id,
  servers: D.SERVER_IDS.github,
  tools: D.TOOLS[7]!.id,
  catalog: D.SERVER_IDS.github,
  audit: D.AUDIT_EVENTS[2]!.id,
  sessions: D.SESSIONS[0]!.id,
  jobs: 'job-sync',
  approvals: D.APPROVALS[0]!.id,
  library: '0193a000-0000-7000-8000-000000000701',
};
const RANGE = { from: '2026-11-23T10:00:00.000Z', to: '2026-11-24T10:00:00.000Z' };

describe('demo fixtures', () => {
  it('only uses keys that exist in the contract', () => {
    const unknown = Object.keys(demoFixtures()).filter((k) => !KEYS.has(k));
    expect(unknown).toEqual([]);
  });

  it('every GET fixture returns a contract-valid 200 through the MSW handlers', async () => {
    const fixtures = demoFixtures();
    const failures: string[] = [];
    for (const { key, def } of ALL_ENDPOINTS) {
      if (def.method !== 'GET' || !(key in fixtures) || def.kind !== 'json') continue;
      const area = key.split('.')[0]!;
      const id = SAMPLE_ID[area] ?? PARAMS.id!.id!;
      const path = buildPath(def.path, { id, keyId: 'k1', userId: D.PEOPLE.sam.id, mappingId: 'cm1', serverId: D.SERVER_IDS.github, requestId: 'r1' });
      const needsRange = /metrics|sessions\.list|audit\.events/.test(key);
      const query = needsRange ? { ...RANGE, interval: '1h', dimension: 'server' } : {};
      const res = await fetch(path + serializeQuery(query));
      if (res.status !== 200) failures.push(`${key} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    expect(failures).toEqual([]);
  });
});
