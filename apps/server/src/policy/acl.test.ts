import { describe, expect, it } from 'vitest';
import { allowedToolIds, evaluateTool, type AclGrant, type AclPrincipal, type AclTool } from './acl.js';

const tool = (over: Partial<AclTool> = {}): AclTool => ({ id: 't1', serverId: 's1', status: 'active', enabled: true, serverEnabled: true, serverStatus: 'active', ...over });
let n = 0;
const g = (subjectType: AclGrant['subjectType'], subjectId: string, targetType: AclGrant['targetType'], targetId: string, effect: AclGrant['effect'], expiresAt: number | null = null): AclGrant => ({ id: `g${++n}`, subjectType, subjectId, targetType, targetId, effect, expiresAt });
const user: AclPrincipal = { userId: 'u1', groupIds: ['g1'], agent: null };
const agent = (narrowed: boolean): AclPrincipal => ({ userId: 'u1', groupIds: ['g1'], agent: { id: 'a1', narrowed } });
const NOW = 1000;

describe('acl evaluate (table)', () => {
  it.each([
    ['no grants', user, [], 'none'],
    ['user allow server', user, [g('user', 'u1', 'server', 's1', 'allow')], 'allow'],
    ['user allow tool', user, [g('user', 'u1', 'tool', 't1', 'allow')], 'allow'],
    ['group allow server', user, [g('group', 'g1', 'server', 's1', 'allow')], 'allow'],
    ['other group', user, [g('group', 'g2', 'server', 's1', 'allow')], 'none'],
    ['other tool', user, [g('user', 'u1', 'tool', 't2', 'allow')], 'none'],
    ['server deny beats tool allow', user, [g('user', 'u1', 'tool', 't1', 'allow'), g('user', 'u1', 'server', 's1', 'deny')], 'deny'],
    ['group deny beats user allow', user, [g('user', 'u1', 'server', 's1', 'allow'), g('group', 'g1', 'tool', 't1', 'deny')], 'deny'],
    ['expired allow ignored', user, [g('user', 'u1', 'server', 's1', 'allow', 999)], 'none'],
    ['expired deny ignored', user, [g('user', 'u1', 'server', 's1', 'allow'), g('user', 'u1', 'server', 's1', 'deny', 1000)], 'allow'],
    ['agent inherits owner', agent(false), [g('user', 'u1', 'server', 's1', 'allow')], 'allow'],
    ['agent deny beats owner allow', agent(false), [g('user', 'u1', 'server', 's1', 'allow'), g('agent', 'a1', 'tool', 't1', 'deny')], 'deny'],
    ['narrowed agent without agent allow', agent(true), [g('user', 'u1', 'server', 's1', 'allow')], 'none'],
    ['narrowed agent with agent allow', agent(true), [g('user', 'u1', 'server', 's1', 'allow'), g('agent', 'a1', 'tool', 't1', 'allow')], 'allow'],
    ['agent allow cannot add access', agent(true), [g('agent', 'a1', 'tool', 't1', 'allow')], 'none'],
    ['agent allow alone (not narrowed) adds nothing', agent(false), [g('agent', 'a1', 'server', 's1', 'allow')], 'none'],
    ['other agent grants ignored', agent(false), [g('user', 'u1', 'server', 's1', 'allow'), g('agent', 'a2', 'server', 's1', 'deny')], 'allow'],
  ] as const)('%s', (_name, p, grants, expected) => {
    expect(evaluateTool(p, tool(), grants, NOW).decision).toBe(expected);
  });

  it.each([
    [{ status: 'pending_review' as const }, 'tool_status'],
    [{ status: 'changed' as const }, 'tool_status'],
    [{ status: 'removed' as const }, 'tool_status'],
    [{ status: 'rejected' as const }, 'tool_status'],
    [{ enabled: false }, 'tool_disabled'],
    [{ serverEnabled: false }, 'server_disabled'],
    [{ serverStatus: 'disabled' as const }, 'server_disabled'],
  ])('tool state %o blocks calls', (over, reason) => {
    const d = evaluateTool(user, tool(over), [g('user', 'u1', 'server', 's1', 'allow')], NOW);
    expect(d).toMatchObject({ decision: 'allow', callable: false, blockedBy: reason });
  });

  it('explains matches and inheritance', () => {
    const allow = g('group', 'g1', 'server', 's1', 'allow');
    const d = evaluateTool(agent(false), tool(), [allow], NOW);
    expect(d.matches).toEqual([{ grant: allow, role: 'owner_allow' }]);
    expect(d.inherited).toBe(true);
  });

  it('allowedToolIds filters', () => {
    const tools = [tool(), tool({ id: 't2' }), tool({ id: 't3', serverId: 's2' })];
    expect([...allowedToolIds(user, tools, [g('user', 'u1', 'server', 's1', 'allow'), g('user', 'u1', 'tool', 't2', 'deny')], NOW)]).toEqual(['t1']);
  });
});
