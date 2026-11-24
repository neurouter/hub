import { diffLines, diffWords } from 'diff';

/** One aligned row of a split (side-by-side) line diff. Empty sides are `null`. */
export interface SplitRow {
  left: { n: number; text: string; kind: 'ctx' | 'del' } | null;
  right: { n: number; text: string; kind: 'ctx' | 'add' } | null;
}

/** One row of a unified diff. */
export interface UnifiedRow {
  kind: 'ctx' | 'del' | 'add';
  oldN: number | null;
  newN: number | null;
  text: string;
}

function toLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line diff aligned for split view (removed lines pair with the following added lines, like the
 * prototype's ToolReview), plus a unified variant and +/- counts.
 */
export function lineDiff(oldText: string, newText: string): { split: SplitRow[]; unified: UnifiedRow[]; added: number; removed: number } {
  const changes = diffLines(oldText, newText);
  const split: SplitRow[] = [];
  const unified: UnifiedRow[] = [];
  let ln = 1;
  let rn = 1;
  let added = 0;
  let removed = 0;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!;
    if (!c.added && !c.removed) {
      for (const t of toLines(c.value)) {
        split.push({ left: { n: ln, text: t, kind: 'ctx' }, right: { n: rn, text: t, kind: 'ctx' } });
        unified.push({ kind: 'ctx', oldN: ln, newN: rn, text: t });
        ln++;
        rn++;
      }
      continue;
    }
    if (c.removed) {
      const del = toLines(c.value);
      const next = changes[i + 1];
      const add = next?.added ? toLines(next.value) : [];
      if (next?.added) i++;
      removed += del.length;
      added += add.length;
      del.forEach((t, k) => unified.push({ kind: 'del', oldN: ln + k, newN: null, text: t }));
      const rows = Math.max(del.length, add.length);
      for (let k = 0; k < rows; k++) {
        const l = del[k];
        const r = add[k];
        split.push({
          left: l !== undefined ? { n: ln++, text: l, kind: 'del' } : null,
          right: r !== undefined ? { n: rn, text: r, kind: 'add' } : null,
        });
        if (r !== undefined) {
          unified.push({ kind: 'add', oldN: null, newN: rn, text: r });
          rn++;
        }
      }
      continue;
    }
    // pure addition
    for (const t of toLines(c.value)) {
      split.push({ left: null, right: { n: rn, text: t, kind: 'add' } });
      unified.push({ kind: 'add', oldN: null, newN: rn, text: t });
      rn++;
      added++;
    }
  }
  return { split, unified, added, removed };
}

export interface WordPart {
  text: string;
  kind: 'same' | 'add' | 'del';
}

/** Word-level diff (descriptions: prompt-injection-style edits matter most). */
export function wordDiff(oldText: string, newText: string): WordPart[] {
  return diffWords(oldText, newText).map((c) => ({ text: c.value, kind: c.added ? 'add' : c.removed ? 'del' : 'same' }));
}
