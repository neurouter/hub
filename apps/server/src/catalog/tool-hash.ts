import { hashCanonical } from '../lib/jcs.js';

/** The pinned part of an upstream tool definition (backend §6 tool sync step 3). */
export interface ToolDefinition {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  execution: Record<string, unknown> | null;
}

export function definitionOf(t: { name: string; title?: string | null; description?: string | null; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown; execution?: unknown }): ToolDefinition {
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  return {
    name: t.name,
    title: typeof t.title === 'string' ? t.title : null,
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: obj(t.inputSchema) ?? { type: 'object' },
    outputSchema: obj(t.outputSchema),
    annotations: obj(t.annotations),
    execution: obj(t.execution),
  };
}

/** sha256(JCS(definition)): key order and whitespace never change the hash. */
export function hashDefinition(def: ToolDefinition): string {
  return hashCanonical(def);
}

const HEADER_TOKEN = /^[A-Za-z0-9-]{1,64}$/;
const PRIMITIVE = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * `x-mcp-header` annotations on input properties must be valid header names, unique
 * (case-insensitive) and on primitive properties; clients MUST drop tools that violate this.
 * Returns the reason, or null when valid.
 */
export function invalidHeaderAnnotation(inputSchema: Record<string, unknown>): string | null {
  const props = inputSchema.properties;
  if (!props || typeof props !== 'object') return null;
  const seen = new Set<string>();
  for (const [prop, schema] of Object.entries(props as Record<string, unknown>)) {
    if (!schema || typeof schema !== 'object' || !('x-mcp-header' in schema)) continue;
    const h = (schema as Record<string, unknown>)['x-mcp-header'];
    if (typeof h !== 'string' || !HEADER_TOKEN.test(h)) return `property "${prop}": invalid x-mcp-header name`;
    const lower = h.toLowerCase();
    if (seen.has(lower)) return `duplicate x-mcp-header "${h}"`;
    seen.add(lower);
    const type = (schema as Record<string, unknown>).type;
    if (typeof type !== 'string' || !PRIMITIVE.has(type)) return `property "${prop}": x-mcp-header requires a primitive type`;
  }
  return null;
}

/** Flattened parameter names + descriptions (depth ≤ 3, ≤ 1k chars) for keyword search (backend §11.1). */
export function searchTextOf(def: Pick<ToolDefinition, 'inputSchema'>): string {
  const names: string[] = [];
  const descs: string[] = [];
  const walk = (schema: unknown, depth: number) => {
    if (depth > 3 || !schema || typeof schema !== 'object') return;
    const props = (schema as Record<string, unknown>).properties;
    if (!props || typeof props !== 'object') return;
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      names.push(k);
      const d = v && typeof v === 'object' ? (v as Record<string, unknown>).description : undefined;
      if (typeof d === 'string') descs.push(d);
      walk(v, depth + 1);
      const items = v && typeof v === 'object' ? (v as Record<string, unknown>).items : undefined;
      if (items) walk(items, depth + 1);
    }
  };
  walk(def.inputSchema, 1);
  return `${names.join(' ')}\n${descs.join(' ').slice(0, 1000)}`.trim();
}
