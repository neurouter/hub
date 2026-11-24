import type { AccessVia, BatchGrantsBody, EffectiveAccess, Grant, GrantEffect, SubjectType } from '@neurouter/shared';

/**
 * Pure logic for the access matrix (§5.2, addendum #6): rows = subjects, columns = "server (all
 * tools)" + each tool. Cells are tri-state (inherit / allow / deny); edits are staged locally and
 * saved as ONE atomic batch.
 */
export type CellValue = 'inherit' | GrantEffect;

export interface MatrixSubject {
  type: SubjectType;
  id: string;
  name: string;
}

export interface MatrixColumn {
  /** `server` for the server-wide column, else the tool id */
  targetType: 'server' | 'tool';
  id: string;
  label: string;
  requiresApproval?: boolean;
}

export const subjectKey = (s: Pick<MatrixSubject, 'type' | 'id'>) => `${s.type}:${s.id}`;
export const cellKey = (s: Pick<MatrixSubject, 'type' | 'id'>, c: Pick<MatrixColumn, 'targetType' | 'id'>) => `${subjectKey(s)}|${c.targetType}:${c.id}`;

/** Direct grants indexed by cell key. */
export function indexGrants(grants: Grant[]): Map<string, Grant> {
  const m = new Map<string, Grant>();
  for (const g of grants) m.set(cellKey(g.subject, { targetType: g.target.type, id: g.target.id }), g);
  return m;
}

/** Subjects that have any grant on the server, plus manually added rows (deduplicated, stable order). */
export function matrixSubjects(grants: Grant[], added: MatrixSubject[]): MatrixSubject[] {
  const out = new Map<string, MatrixSubject>();
  const order: Record<SubjectType, number> = { group: 0, user: 1, agent: 2 };
  for (const g of [...grants].sort((a, b) => order[a.subject.type] - order[b.subject.type] || a.subject.name.localeCompare(b.subject.name))) {
    out.set(subjectKey(g.subject), { type: g.subject.type, id: g.subject.id, name: g.subject.name });
  }
  for (const s of added) if (!out.has(subjectKey(s))) out.set(subjectKey(s), s);
  return [...out.values()];
}

export function baseValue(index: Map<string, Grant>, key: string): CellValue {
  return index.get(key)?.effect ?? 'inherit';
}

/** Applies a staged pick: picking the original value removes the staged entry. */
export function stage(staged: Record<string, CellValue>, key: string, value: CellValue, original: CellValue): Record<string, CellValue> {
  const next = { ...staged };
  if (value === original) delete next[key];
  else next[key] = value;
  return next;
}

/** Atomic batch for POST /api/grants/batch: allow/deny → upsert, inherit over a grant → delete. */
export function batchBody(staged: Record<string, CellValue>, index: Map<string, Grant>): BatchGrantsBody {
  const upserts: BatchGrantsBody['upserts'] = [];
  const deletes: string[] = [];
  for (const [key, value] of Object.entries(staged)) {
    const [subj, target] = key.split('|') as [string, string];
    const [subjectType, subjectId] = splitOnce(subj);
    const [targetType, targetId] = splitOnce(target);
    if (value === 'inherit') {
      const g = index.get(key);
      if (g) deletes.push(g.id);
    } else {
      upserts.push({ subject: { type: subjectType as SubjectType, id: subjectId }, target: { type: targetType as 'server' | 'tool', id: targetId }, effect: value });
    }
  }
  return { upserts, deletes };
}

function splitOnce(s: string): [string, string] {
  const i = s.indexOf(':');
  return [s.slice(0, i), s.slice(i + 1)];
}

export interface Inherited {
  effect: GrantEffect;
  source: string;
}

/**
 * Inherited access shown in an "inherit" cell (addendum #6):
 * - a server-wide grant of the same subject applies to every tool column;
 * - for users/agents, the effective-access explanation (`perTool[].via`) names groups / owner.
 * Deny wins when several sources apply.
 */
export function inheritedFor(
  subject: MatrixSubject,
  column: MatrixColumn,
  index: Map<string, Grant>,
  effective: EffectiveAccess | undefined,
  server: { id: string; name: string },
  staged: Record<string, CellValue> = {},
): Inherited | null {
  if (column.targetType === 'server') return null;
  const found: Inherited[] = [];
  const swKey = cellKey(subject, { targetType: 'server', id: server.id });
  const serverWide = swKey in staged ? staged[swKey] : index.get(swKey)?.effect;
  if (serverWide && serverWide !== 'inherit') found.push({ effect: serverWide, source: `server-wide grant on ${server.name}` });
  const perTool = effective?.perTool?.find((t) => t.toolId === column.id);
  if (perTool?.inherited && perTool.decision !== 'none') {
    const via = (perTool.via ?? []).filter((v) => v.kind !== 'direct');
    if (via.length) found.push({ effect: perTool.decision, source: via.map(describeVia).join(', ') });
  }
  if (!found.length) return null;
  return found.find((f) => f.effect === 'deny') ?? found[0]!;
}

export function describeVia(v: AccessVia): string {
  if (v.kind === 'group') return `via group:${v.subject.name}`;
  if (v.kind === 'owner') return `via owner ${v.subject.name}`;
  if (v.kind === 'server') return `via server-wide grant to ${v.subject.type}:${v.subject.name}`;
  return `direct grant to ${v.subject.type}:${v.subject.name}`;
}

/** "allow agent:release-bot → delete_branch · deny group:contractors → github (all)" */
export function stagedSummary(staged: Record<string, CellValue>, names: Map<string, string>, max = 3): string {
  const entries = Object.entries(staged);
  const parts = entries.slice(0, max).map(([k, v]) => {
    const [s, t] = k.split('|') as [string, string];
    return `${v} ${names.get(s) ?? s} → ${names.get(t) ?? t}`;
  });
  return parts.join(' · ') + (entries.length > max ? ' · …' : '');
}

/** Case-insensitive column search for servers with many tools. The server-wide column always stays. */
export function filterColumns(cols: MatrixColumn[], q: string): MatrixColumn[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return cols;
  return cols.filter((c) => c.targetType === 'server' || c.label.toLowerCase().includes(needle));
}
