/**
 * Deterministic lint of MCP tool definitions (no model involved). Used by the library check
 * (definitions listed without credentials) and by the grade of servers already in the gateway.
 *
 * Per tool, a 0–1 score from:
 *   description 35% · typed input schema 25% · parameter docs 20% · annotations 10% · name 10%
 * Server aggregate: 0.6 × mean + 0.4 × min, so one bad tool pulls the score down.
 * Injection-like text and hidden Unicode are reported separately as red flags.
 */

export interface LintableTool {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: unknown;
  annotations?: Record<string, unknown> | null;
}

export interface ToolLint {
  name: string;
  score: number;
  issues: string[];
}

export interface DefinitionLint {
  tools: ToolLint[];
  /** 0.6 × mean + 0.4 × min; null without tools. */
  score: number | null;
  /** Tools whose text looks like instructions to the model. */
  injection: Array<{ tool: string; match: string }>;
  hiddenUnicode: string[];
  contradictions: string[];
  oversized: string[];
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DESTRUCTIVE_NAME = /(^|[_.-])(delete|remove|drop|destroy|purge|truncate|wipe|erase)([_.-]|$)/i;
const MAX_DESCRIPTION = 2000;

/**
 * Phrases that address the model rather than describe the tool (tool-poisoning write-ups). Kept
 * narrow on purpose: a false positive caps a grade, so each pattern needs instruction-like intent.
 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier|other)\s+(instructions|prompts|rules|directions)\b/i, 'ignore previous instructions'],
  [/\bdisregard\s+(all\s+|any\s+)?(previous|prior|above|the\s+system)\b/i, 'disregard previous instructions'],
  [/\b(do\s+not|don't|never)\s+(tell|inform|mention\s+(this\s+)?to|reveal\s+(this\s+)?to|alert)\s+the\s+user\b/i, 'hide from the user'],
  [/\byou\s+must\s+(always\s+)?(first\s+)?(call|invoke|use|run)\s+/i, 'you must call'],
  [/\balways\s+(call|invoke|run)\s+this\s+tool\b/i, 'always call this tool'],
  [/\bbefore\s+(using|calling)\s+any\s+other\s+tool\b/i, 'before any other tool'],
  [/<\s*\/?\s*(important|system|instructions?|secret)\s*>/i, 'pseudo-tag addressed to the model'],
  [/\b(read|send|upload|include)\b[^.]{0,60}\b(~\/\.ssh|id_rsa|\.env\b|credentials|api[_ -]?keys?|private key)/i, 'asks for secrets'],
];

// zero-width and bidi control characters
const HIDDEN_UNICODE = new RegExp(`[${[[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCodePoint(a!)}-${String.fromCodePoint(b!)}`).join('')}]`);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** "get_user" vs "Get user." — a description that only restates the name says nothing. */
export function restatesName(name: string, description: string): boolean {
  const n = normalize(name);
  const d = normalize(description);
  return d === n || d === `${n} tool` || d.split(' ').filter((w) => !n.split(' ').includes(w)).length === 0;
}

function schemaProperties(schema: unknown): Array<[string, Record<string, unknown>]> {
  if (!schema || typeof schema !== 'object') return [];
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object') return [];
  return Object.entries(props as Record<string, unknown>).map(([k, v]) => [k, v && typeof v === 'object' ? (v as Record<string, unknown>) : {}]);
}

/** Every description-like string in the definition (tool + parameters), for the red-flag scans. */
function texts(t: LintableTool): string[] {
  const out = [t.title ?? '', t.description ?? ''];
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === 'description' || k === 'title') && typeof v === 'string') out.push(v);
      else if (typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(t.inputSchema, 0);
  return out.filter(Boolean);
}

export function lintTool(t: LintableTool): ToolLint {
  const issues: string[] = [];
  const desc = (t.description ?? '').trim();
  let description: number;
  if (!desc) {
    description = 0;
    issues.push('No description');
  } else if (desc.length < 20 || restatesName(t.name, desc)) {
    description = 0.4;
    issues.push(desc.length < 20 ? 'Description is very short' : 'Description only restates the name');
  } else {
    description = 1;
  }

  const schema = t.inputSchema as { type?: unknown } | undefined;
  const props = schemaProperties(t.inputSchema);
  let typed: number;
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') {
    typed = 0;
    issues.push('Input schema is not a typed object');
  } else if (!props.length) {
    typed = 1;
  } else {
    const withType = props.filter(([, p]) => p.type !== undefined || p.enum !== undefined || p.const !== undefined || p.anyOf !== undefined || p.oneOf !== undefined || p.$ref !== undefined).length;
    typed = withType / props.length;
    if (withType < props.length) issues.push(`${props.length - withType} of ${props.length} parameters have no type`);
  }

  let paramDocs = 1;
  if (props.length) {
    const documented = props.filter(([, p]) => typeof p.description === 'string' && p.description.trim().length > 0).length;
    paramDocs = documented / props.length;
    if (documented < props.length) issues.push(`${props.length - documented} of ${props.length} parameters have no description`);
  }

  const a = t.annotations ?? {};
  const annotated = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].some((k) => typeof a[k] === 'boolean');
  if (!annotated) issues.push('No behaviour annotations (readOnlyHint, destructiveHint…)');

  const nameOk = NAME_RE.test(t.name);
  if (!nameOk) issues.push('Name has characters or a length clients may reject');

  const score = 0.35 * description + 0.25 * typed + 0.2 * paramDocs + 0.1 * (annotated ? 1 : 0) + 0.1 * (nameOk ? 1 : 0);
  return { name: t.name, score: Math.round(score * 1000) / 1000, issues };
}

export function lintDefinitions(tools: readonly LintableTool[]): DefinitionLint {
  const linted = tools.map(lintTool);
  const injection: DefinitionLint['injection'] = [];
  const hiddenUnicode: string[] = [];
  const contradictions: string[] = [];
  const oversized: string[] = [];
  for (const t of tools) {
    const all = texts(t);
    for (const s of all) {
      const hit = INJECTION_PATTERNS.find(([re]) => re.test(s));
      if (hit) {
        injection.push({ tool: t.name, match: hit[1] });
        break;
      }
    }
    if (all.some((s) => HIDDEN_UNICODE.test(s)) || HIDDEN_UNICODE.test(t.name)) hiddenUnicode.push(t.name);
    if (DESTRUCTIVE_NAME.test(t.name) && t.annotations?.readOnlyHint === true) contradictions.push(t.name);
    if ((t.description ?? '').length > MAX_DESCRIPTION) oversized.push(t.name);
  }
  let score: number | null = null;
  if (linted.length) {
    const mean = linted.reduce((s, x) => s + x.score, 0) / linted.length;
    const min = Math.min(...linted.map((x) => x.score));
    score = Math.round((0.6 * mean + 0.4 * min) * 1000) / 1000;
  }
  return { tools: linted, score, injection, hiddenUnicode, contradictions, oversized };
}
