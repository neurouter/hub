import vm from 'node:vm';
import { isRedactedMarker } from '@neurouter/shared';

/**
 * Pure redaction (backend §9.2). Applied to tool arguments, search queries, admin `changes` and
 * (when enabled) full outputs, BEFORE hashing into the chain, so the chain covers exactly what is
 * stored and redacted values are never searchable.
 *
 * - key rules: an object key matching the (case-insensitive) pattern → the whole value becomes
 *   the marker `{"$redacted": "<rule name>"}`;
 * - regex rules (strings only): a whole-string match → marker; a partial match → inline
 *   `[REDACTED:<rule name>]`;
 * - rules apply in `order`, first match wins per value;
 * - shape limits: strings 4 KB, arrays 200 items, depth 16.
 */
export interface RedactionRuleDef {
  id: string;
  name: string;
  type: 'key' | 'regex';
  pattern: string;
  /** '' (or the default) → marker object / inline token; anything else is used verbatim. */
  replacement: string;
  enabled: boolean;
  order: number;
  builtin: boolean;
}

export const DEFAULT_REPLACEMENT = '';
export const MAX_STRING_BYTES = 4096;
export const MAX_ARRAY_ITEMS = 200;
export const MAX_DEPTH = 16;
export const PARAMS_TEXT_MAX = 16 * 1024;

/** Built-in rules (seeded into `redaction_rules`; can be disabled but not deleted). */
export const BUILTIN_RULES: ReadonlyArray<Omit<RedactionRuleDef, 'id'>> = [
  { name: 'sensitive-key', type: 'key', pattern: '(pass(word)?|secret|token|api[-_]?key|authorization|auth|cookie|session|private[-_]?key|client[-_]?secret|credential|ssn|card(number)?|cvv|iban)', replacement: '', enabled: true, order: 10, builtin: true },
  { name: 'jwt', type: 'regex', pattern: 'eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]*', replacement: '', enabled: true, order: 20, builtin: true },
  { name: 'bearer-token', type: 'regex', pattern: 'Bearer\\s+\\S+', replacement: '', enabled: true, order: 30, builtin: true },
  { name: 'pem-block', type: 'regex', pattern: '-----BEGIN [A-Z ]+-----[\\s\\S]*?-----END [A-Z ]+-----', replacement: '', enabled: true, order: 40, builtin: true },
  { name: 'aws-access-key', type: 'regex', pattern: 'AKIA[0-9A-Z]{16}', replacement: '', enabled: true, order: 50, builtin: true },
  { name: 'github-token', type: 'regex', pattern: 'gh[pousr]_[A-Za-z0-9]{36,}', replacement: '', enabled: true, order: 60, builtin: true },
  { name: 'slack-token', type: 'regex', pattern: 'xox[abprs]-[A-Za-z0-9-]{10,}', replacement: '', enabled: true, order: 70, builtin: true },
  { name: 'neurouter-token', type: 'regex', pattern: 'nr_(live|at|rt)_[A-Za-z0-9_]+', replacement: '', enabled: true, order: 80, builtin: true },
  { name: 'credit-card', type: 'regex', pattern: '\\b(?:\\d[ -]?){12,18}\\d\\b', replacement: '', enabled: true, order: 90, builtin: true },
  { name: 'email', type: 'regex', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', replacement: '', enabled: false, order: 100, builtin: true },
];

/** Luhn check used by the built-in credit-card rule (13–19 digits). */
export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export interface RedactionMatch {
  path: string[];
  ruleId: string;
}

interface CompiledRule {
  def: RedactionRuleDef;
  re: RegExp;
  /** extra check for a candidate match (credit cards) */
  accept?: (m: string) => boolean;
}

export interface RedactResult<T = unknown> {
  value: T;
  matches: RedactionMatch[];
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function truncate(s: string): string {
  const len = byteLength(s);
  if (len <= MAX_STRING_BYTES) return s;
  let cut = Buffer.from(s, 'utf8').subarray(0, MAX_STRING_BYTES).toString('utf8');
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return `${cut}…[truncated ${len - byteLength(cut)} bytes]`;
}

export class Redactor {
  private readonly keyRules: CompiledRule[];
  private readonly valueRules: CompiledRule[];

  constructor(rules: readonly RedactionRuleDef[]) {
    const enabled = [...rules].filter((r) => r.enabled).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    const compile = (r: RedactionRuleDef): CompiledRule | null => {
      try {
        const re = r.type === 'key' ? new RegExp(r.pattern, 'i') : new RegExp(r.pattern, 'g');
        return { def: r, re, ...(r.builtin && r.name === 'credit-card' ? { accept: luhnValid } : {}) };
      } catch {
        return null; // invalid stored rule: skipped (validated on save)
      }
    };
    this.keyRules = enabled.filter((r) => r.type === 'key').map(compile).filter((c): c is CompiledRule => c !== null);
    this.valueRules = enabled.filter((r) => r.type === 'regex').map(compile).filter((c): c is CompiledRule => c !== null);
  }

  static builtins(): Redactor {
    return new Redactor(BUILTIN_RULES.map((r, i) => ({ ...r, id: `builtin-${i}` })));
  }

  private marker(rule: RedactionRuleDef): unknown {
    return rule.replacement && rule.replacement !== DEFAULT_REPLACEMENT ? rule.replacement : { $redacted: rule.name };
  }

  private redactString(s: string, path: string[], matches: RedactionMatch[]): unknown {
    for (const rule of this.valueRules) {
      rule.re.lastIndex = 0;
      let hit = false;
      let whole = false;
      const replaced = s.replace(rule.re, (m: string) => {
        if (rule.accept && !rule.accept(m)) return m;
        hit = true;
        if (m.length === s.length) whole = true;
        return rule.def.replacement || `[REDACTED:${rule.def.name}]`;
      });
      if (hit) {
        matches.push({ path, ruleId: rule.def.id });
        return whole ? this.marker(rule.def) : truncate(replaced);
      }
    }
    return truncate(s);
  }

  private walk(v: unknown, path: string[], depth: number, matches: RedactionMatch[]): unknown {
    if (typeof v === 'string') return this.redactString(v, path, matches);
    if (v === null || typeof v !== 'object') return v;
    if (isRedactedMarker(v)) return v;
    if (depth >= MAX_DEPTH) return '[truncated: max depth]';
    if (Array.isArray(v)) {
      const out = v.slice(0, MAX_ARRAY_ITEMS).map((item, i) => this.walk(item, [...path, String(i)], depth + 1, matches));
      if (v.length > MAX_ARRAY_ITEMS) out.push(`[truncated ${v.length - MAX_ARRAY_ITEMS} items]`);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const rule = this.keyRules.find((r) => r.re.test(k));
      if (rule) {
        matches.push({ path: [...path, k], ruleId: rule.def.id });
        out[k] = this.marker(rule.def);
        continue;
      }
      out[k] = this.walk(child, [...path, k], depth + 1, matches);
    }
    return out;
  }

  redact<T = unknown>(value: T): RedactResult<T> {
    const matches: RedactionMatch[] = [];
    return { value: this.walk(value, [], 0, matches) as T, matches };
  }
}

/**
 * `params_text` (approved addendum 4, bounded FTS): the flattened, already redacted leaf values
 * whose key is in the allow-list (`*` = every key), capped at 16 KB. Markers never contribute.
 */
export function paramsText(redacted: unknown, allowKeys: readonly string[]): string | null {
  if (!allowKeys.length) return null;
  const all = allowKeys.includes('*');
  const allow = new Set(allowKeys.map((k) => k.toLowerCase()));
  const parts: string[] = [];
  let size = 0;
  const push = (s: string) => {
    if (size >= PARAMS_TEXT_MAX) return;
    const piece = s.slice(0, PARAMS_TEXT_MAX - size);
    parts.push(piece);
    size += piece.length + 1;
  };
  const visit = (v: unknown, key: string | null, depth: number) => {
    if (size >= PARAMS_TEXT_MAX || depth > MAX_DEPTH) return;
    if (v === null || v === undefined) return;
    if (typeof v === 'object') {
      if (isRedactedMarker(v)) return;
      if (Array.isArray(v)) {
        for (const item of v) visit(item, key, depth + 1);
        return;
      }
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) visit(child, k, depth + 1);
      return;
    }
    if (key === null || !(all || allow.has(key.toLowerCase()))) return;
    const s = String(v);
    if (s.startsWith('[REDACTED:') && s.endsWith(']')) return;
    push(s.replace(/\[REDACTED:[^\]]*\]/g, ' '));
  };
  visit(redacted, null, 0);
  const text = parts.join(' ').trim();
  return text ? text : null;
}

/** Sample used to reject catastrophic-backtracking patterns on save (§9.2: 50 ms over 10 KB). */
const SAFETY_SAMPLES = [
  'a'.repeat(10_000) + '!',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.repeat(10).concat('x@'.repeat(4500)).slice(0, 10_000),
  Array.from({ length: 10_000 }, (_, i) => String.fromCharCode(32 + ((i * 7) % 95))).join(''),
  '0'.repeat(9_999) + 'x',
];

export type PatternCheck = { ok: true } | { ok: false; reason: 'invalid' | 'too_slow'; message: string };

/** Compiles and runs the pattern against 10 KB samples with a 50 ms budget per sample. */
export function checkPattern(type: 'key' | 'regex', pattern: string, budgetMs = 50): PatternCheck {
  let re: RegExp;
  try {
    re = new RegExp(pattern, type === 'key' ? 'i' : 'g');
  } catch (err) {
    return { ok: false, reason: 'invalid', message: (err as Error).message };
  }
  for (const s of SAFETY_SAMPLES) {
    try {
      vm.runInNewContext('re.lastIndex = 0; s.replace(re, "")', { re, s }, { timeout: budgetMs });
    } catch {
      return { ok: false, reason: 'too_slow', message: `The pattern takes longer than ${budgetMs} ms on a 10 KB sample (catastrophic backtracking)` };
    }
  }
  return { ok: true };
}
