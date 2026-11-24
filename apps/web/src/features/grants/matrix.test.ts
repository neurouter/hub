import { describe, expect, it } from 'vitest';
import type { EffectiveAccess, Grant } from '@neurouter/shared';
import { GRANTS, GROUPS, SERVER_IDS, TOOL_BY_QN } from '@/mocks/demo-data';
import { batchBody, cellKey, filterColumns, indexGrants, inheritedFor, matrixSubjects, stage, stagedSummary, type MatrixColumn } from './matrix';

const github = GRANTS.filter((g) => g.target.server.id === SERVER_IDS.github);
const index = indexGrants(github);
const contractors = { type: 'group' as const, id: GROUPS.contractors.id, name: 'contractors' };
const del = TOOL_BY_QN['github__delete_branch']!;
const create = TOOL_BY_QN['github__create_issue']!;
const toolCol = (t: { id: string; name: string }): MatrixColumn => ({ targetType: 'tool', id: t.id, label: t.name });
const server = { id: SERVER_IDS.github, name: 'github' };

describe('access matrix logic', () => {
  it('lists subjects with grants (groups, then users, then agents) plus added rows once', () => {
    const subjects = matrixSubjects(github, [{ type: 'user', id: 'u-new', name: 'new.person' }, contractors]);
    expect(subjects.map((s) => s.type)).toEqual(['group', 'group', 'group', 'user', 'agent', 'agent', 'user']);
    expect(subjects.filter((s) => s.id === contractors.id)).toHaveLength(1);
  });

  it('stages edits and drops them when set back to the original value', () => {
    const key = cellKey(contractors, toolCol(create));
    let st = stage({}, key, 'deny', 'inherit');
    expect(st).toEqual({ [key]: 'deny' });
    st = stage(st, key, 'inherit', 'inherit');
    expect(st).toEqual({});
  });

  it('builds one atomic batch: allow/deny → upserts, inherit over an existing grant → delete', () => {
    const existing = cellKey(contractors, toolCol(del)); // contractors deny delete_branch
    const fresh = cellKey(contractors, toolCol(create));
    const body = batchBody({ [existing]: 'inherit', [fresh]: 'allow' }, index);
    expect(body.deletes).toEqual([index.get(existing)!.id]);
    expect(body.upserts).toEqual([{ subject: { type: 'group', id: contractors.id }, target: { type: 'tool', id: create.id }, effect: 'allow' }]);
  });

  it('shows inherited access from a server-wide grant (also when staged) and via groups', () => {
    expect(inheritedFor(contractors, toolCol(create), index, undefined, server)).toEqual({ effect: 'allow', source: 'server-wide grant on github' });
    const serverKey = cellKey(contractors, { targetType: 'server', id: SERVER_IDS.github });
    expect(inheritedFor(contractors, toolCol(create), index, undefined, server, { [serverKey]: 'deny' })?.effect).toBe('deny');
    const sam = { type: 'user' as const, id: 'u-sam', name: 'sam' };
    const eff: EffectiveAccess = {
      decision: 'allow',
      reasons: [],
      perTool: [{ toolId: create.id, qualifiedName: create.qualifiedName, decision: 'allow', inherited: true, via: [{ kind: 'group', grantId: 'g1', subject: { type: 'group', id: GROUPS.engineering.id, name: 'engineering' } }] }],
    };
    expect(inheritedFor(sam, toolCol(create), indexGrants([] as Grant[]), eff, server)).toEqual({ effect: 'allow', source: 'via group:engineering' });
    expect(inheritedFor(sam, { targetType: 'server', id: SERVER_IDS.github, label: 'all' }, index, eff, server)).toBeNull();
  });

  it('summarises staged changes and filters tool columns by search', () => {
    const key = cellKey(contractors, toolCol(create));
    const names = new Map([[`group:${contractors.id}`, 'group:contractors'], [`tool:${create.id}`, 'create_issue']]);
    expect(stagedSummary({ [key]: 'deny' }, names)).toBe('deny group:contractors → create_issue');
    const cols: MatrixColumn[] = [{ targetType: 'server', id: 's', label: 'Server (all tools)' }, toolCol(create), toolCol(del)];
    expect(filterColumns(cols, 'DELETE').map((c) => c.label)).toEqual(['Server (all tools)', 'delete_branch']);
    expect(filterColumns(cols, '')).toHaveLength(3);
  });
});
