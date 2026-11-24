import { sha256 } from '../lib/crypto.js';

export const MAX_DOCUMENT_CHARS = 2000;
const MAX_PARAM_DESCRIPTION_CHARS = 1000;
const MAX_PARAM_DEPTH = 3;

export interface ToolDocumentInput {
  exposedName: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
}

/** Parameter names (dotted, up to depth 3) and their descriptions from a JSON Schema's `properties`. */
export function paramInfo(schema: unknown): { names: string[]; descriptions: string[] } {
  const names: string[] = [];
  const descriptions: string[] = [];
  const walk = (node: unknown, prefix: string, depth: number) => {
    if (!node || typeof node !== 'object' || depth > MAX_PARAM_DEPTH) return;
    const n = node as Record<string, unknown>;
    const props = n.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
        const name = prefix ? `${prefix}.${key}` : key;
        names.push(name);
        const d = child && typeof child === 'object' ? (child as Record<string, unknown>).description : undefined;
        if (typeof d === 'string' && d.trim()) descriptions.push(`${name}: ${d.trim()}`);
        walk(child, name, depth + 1);
      }
    }
    // arrays of objects: descend into `items` without adding a name segment
    if (n.items && typeof n.items === 'object') walk(n.items, prefix, depth);
  };
  walk(schema, '', 1);
  return { names, descriptions };
}

/**
 * Search document for a tool (backend §11.1): name, title, description, parameter names and
 * (truncated) parameter descriptions, capped at 2,000 characters.
 */
export function toolDocument(t: ToolDocumentInput): string {
  const { names, descriptions } = paramInfo(t.inputSchema);
  const paramText = descriptions.join('\n').slice(0, MAX_PARAM_DESCRIPTION_CHARS);
  const doc = `${t.exposedName}\n${t.title ?? ''}\n${t.description ?? ''}\nparameters: ${names.join(', ')}\n${paramText}`;
  return doc.slice(0, MAX_DOCUMENT_CHARS);
}

/** `text_hash = sha256(document + model_id)`: a change in either re-embeds the tool. */
export function textHash(document: string, modelId: string): string {
  return sha256(`${document}\u0000${modelId}`).toString('hex');
}
