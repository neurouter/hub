import type { DefinitionDiff } from '@neurouter/shared';

export interface ChangeChip {
  label: string;
  tone: 'warn' | 'danger';
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => (v === undefined ? 'unset' : typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

/** Leaf values of a JSON schema fragment as dotted paths (arrays compared as a whole). */
function leaves(v: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (isObj(v)) {
    for (const [k, child] of Object.entries(v)) for (const [p, x] of leaves(child, prefix ? `${prefix}.${k}` : k)) out.set(p, x);
  } else out.set(prefix, v);
  return out;
}

/** Annotation changes that widen what a tool may do are flagged as danger (red). */
function annotationDanger(key: string, before: unknown, after: unknown): boolean {
  if (key === 'readOnlyHint') return before === true && after !== true;
  if (key === 'destructiveHint') return after === true && before !== true;
  return false;
}

/**
 * Summary chips for a tool definition change (§5.2 Review, W3 acceptance): description/title
 * changes, added/removed params, changed schema constraints and annotation flips.
 * Pure and deterministic (keys sorted) so it is unit-testable.
 */
export function summarizeDefinitionChange(diff: DefinitionDiff, maxConstraintChips = 4): ChangeChip[] {
  const { pinned, current } = diff;
  if (!pinned) return [{ label: 'New tool', tone: 'warn' }];
  const chips: ChangeChip[] = [];
  if (pinned.description !== current.description) chips.push({ label: 'Description changed', tone: 'warn' });
  if ((pinned.title ?? '') !== (current.title ?? '')) chips.push({ label: 'Title changed', tone: 'warn' });

  const pProps = isObj(pinned.inputSchema.properties) ? pinned.inputSchema.properties : {};
  const cProps = isObj(current.inputSchema.properties) ? current.inputSchema.properties : {};
  const added = Object.keys(cProps).filter((k) => !(k in pProps)).sort();
  const removed = Object.keys(pProps).filter((k) => !(k in cProps)).sort();
  if (added.length) chips.push({ label: `+${added.length} param${added.length > 1 ? 's' : ''} · ${added.join(', ')}`, tone: 'warn' });
  if (removed.length) chips.push({ label: `−${removed.length} param${removed.length > 1 ? 's' : ''} · ${removed.join(', ')}`, tone: 'warn' });

  const pReq = new Set(Array.isArray(pinned.inputSchema.required) ? (pinned.inputSchema.required as string[]) : []);
  const cReq = new Set(Array.isArray(current.inputSchema.required) ? (current.inputSchema.required as string[]) : []);
  const newlyRequired = [...cReq].filter((k) => !pReq.has(k) && k in pProps).sort();
  if (newlyRequired.length) chips.push({ label: `now required · ${newlyRequired.join(', ')}`, tone: 'warn' });

  const constraint: ChangeChip[] = [];
  for (const name of Object.keys(cProps).filter((k) => k in pProps).sort()) {
    const before = leaves(pProps[name]);
    const after = leaves(cProps[name]);
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      if (path === 'description') continue;
      const b = before.get(path);
      const a = after.get(path);
      if (JSON.stringify(b) !== JSON.stringify(a)) constraint.push({ label: `${name}.${path} ${show(b)} → ${show(a)}`, tone: 'warn' });
    }
  }
  chips.push(...constraint.slice(0, maxConstraintChips));
  if (constraint.length > maxConstraintChips) chips.push({ label: `+${constraint.length - maxConstraintChips} more schema changes`, tone: 'warn' });

  const pAnn = pinned.annotations ?? {};
  const cAnn = current.annotations ?? {};
  for (const key of [...new Set([...Object.keys(pAnn), ...Object.keys(cAnn)])].sort()) {
    if (key === 'title') continue;
    const b = pAnn[key];
    const a = cAnn[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) chips.push({ label: `${key} ${show(b)} → ${show(a)}`, tone: annotationDanger(key, b, a) ? 'danger' : 'warn' });
  }
  if (!chips.length && pinned.hash !== current.hash) chips.push({ label: 'Output schema or metadata changed', tone: 'warn' });
  return chips;
}
