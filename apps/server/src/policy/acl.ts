/**
 * Pure ACL evaluator (backend §5.3). Deny wins at every level; agent allow-grants only narrow.
 *
 *   ownerAllowed = ∃ allow (subject ∈ {user} ∪ groups) on (server(T) or T)
 *   ownerDenied  = ∃ deny  (subject ∈ {user} ∪ groups ∪ {agent}) on (server(T) or T)
 *   agentAllowed = !agent.narrowed || ∃ allow (subject = agent) on (server(T) or T)
 *   allowed(T)   = ownerAllowed && agentAllowed && !ownerDenied
 *
 * No role grants call access implicitly (Q3).
 */
export type SubjectType = 'user' | 'group' | 'agent';

export interface AclGrant {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  targetType: 'server' | 'tool';
  targetId: string;
  effect: 'allow' | 'deny';
  expiresAt: number | null;
}

export interface AclTool {
  id: string;
  serverId: string;
  status: 'pending_review' | 'active' | 'changed' | 'removed' | 'rejected';
  enabled: boolean;
  serverEnabled: boolean;
  serverStatus: 'active' | 'disabled' | 'error';
}

export interface AclPrincipal {
  userId: string;
  groupIds: readonly string[];
  agent: { id: string; narrowed: boolean } | null;
}

export type GrantRole = 'owner_allow' | 'agent_allow' | 'deny';

export interface ToolDecision {
  /** Grant-level decision. */
  decision: 'allow' | 'deny' | 'none';
  /** Grant decision AND the tool/server state permit a call. */
  callable: boolean;
  /** Why a granted tool still cannot be called. */
  blockedBy: 'tool_status' | 'tool_disabled' | 'server_disabled' | null;
  /** Grants that matched, with the role they played. */
  matches: { grant: AclGrant; role: GrantRole }[];
  /** True when an agent's access comes from its owner (agent not narrowed). */
  inherited: boolean;
}

export function isGrantLive(g: AclGrant, now: number): boolean {
  return g.expiresAt === null || g.expiresAt > now;
}

function targets(g: AclGrant, tool: Pick<AclTool, 'id' | 'serverId'>): boolean {
  return (g.targetType === 'tool' && g.targetId === tool.id) || (g.targetType === 'server' && g.targetId === tool.serverId);
}

export function toolBlockedBy(tool: AclTool): ToolDecision['blockedBy'] {
  if (!tool.serverEnabled || tool.serverStatus === 'disabled') return 'server_disabled';
  if (tool.status !== 'active') return 'tool_status';
  if (!tool.enabled) return 'tool_disabled';
  return null;
}

export function evaluateTool(p: AclPrincipal, tool: AclTool, grants: readonly AclGrant[], now: number): ToolDecision {
  const groups = new Set(p.groupIds);
  const isOwnerSubject = (g: AclGrant) => (g.subjectType === 'user' && g.subjectId === p.userId) || (g.subjectType === 'group' && groups.has(g.subjectId));
  const isAgentSubject = (g: AclGrant) => p.agent !== null && g.subjectType === 'agent' && g.subjectId === p.agent.id;

  const matches: ToolDecision['matches'] = [];
  let ownerAllowed = false;
  let denied = false;
  let agentAllowGrant = false;
  for (const g of grants) {
    if (!isGrantLive(g, now) || !targets(g, tool)) continue;
    if (g.effect === 'deny' && (isOwnerSubject(g) || isAgentSubject(g))) {
      denied = true;
      matches.push({ grant: g, role: 'deny' });
    } else if (g.effect === 'allow' && isOwnerSubject(g)) {
      ownerAllowed = true;
      matches.push({ grant: g, role: 'owner_allow' });
    } else if (g.effect === 'allow' && isAgentSubject(g)) {
      agentAllowGrant = true;
      matches.push({ grant: g, role: 'agent_allow' });
    }
  }
  const agentAllowed = p.agent === null || !p.agent.narrowed || agentAllowGrant;
  const decision: ToolDecision['decision'] = denied ? 'deny' : ownerAllowed && agentAllowed ? 'allow' : 'none';
  const blockedBy = toolBlockedBy(tool);
  return { decision, callable: decision === 'allow' && blockedBy === null, blockedBy, matches, inherited: p.agent !== null && !p.agent.narrowed && decision === 'allow' };
}

/** Ids of every tool the principal may call right now. */
export function allowedToolIds(p: AclPrincipal, tools: readonly AclTool[], grants: readonly AclGrant[], now: number): Set<string> {
  const out = new Set<string>();
  for (const t of tools) if (evaluateTool(p, t, grants, now).callable) out.add(t.id);
  return out;
}

/** Grants whose subject is relevant to the principal (pre-filter before evaluation). */
export function relevantSubjects(p: AclPrincipal): { type: SubjectType; id: string }[] {
  return [{ type: 'user', id: p.userId }, ...p.groupIds.map((id) => ({ type: 'group' as const, id })), ...(p.agent ? [{ type: 'agent' as const, id: p.agent.id }] : [])];
}
