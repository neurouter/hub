import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

const MAX_DEPTH = 32;
const MAX_SUBSCHEMAS = 2000;

function measure(schema: unknown, depth = 0, acc = { count: 0, maxDepth: 0 }): { count: number; maxDepth: number } {
  if (!schema || typeof schema !== 'object') return acc;
  acc.count++;
  acc.maxDepth = Math.max(acc.maxDepth, depth);
  if (acc.count > MAX_SUBSCHEMAS || depth > MAX_DEPTH) return acc;
  for (const v of Array.isArray(schema) ? schema : Object.values(schema)) measure(v, depth + 1, acc);
  return acc;
}

export type ArgCheck = { ok: true } | { ok: false; errors: string[] };

/**
 * Validates `call_tool` arguments against the PINNED input schema (backend §5.6 step 3):
 * JSON Schema 2020-12 via Ajv, compiled once per pinned hash, with depth/size limits and no
 * remote `$ref` resolution (an unresolvable schema fails closed).
 */
export class ArgValidator {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<string, ValidateFunction | Error>();

  constructor() {
    this.ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false, allowUnionTypes: true, loopRequired: 200, loopEnum: 200 });
    addFormats(this.ajv);
  }

  private compile(hash: string, schema: Record<string, unknown>): ValidateFunction | Error {
    const hit = this.cache.get(hash);
    if (hit) return hit;
    let out: ValidateFunction | Error;
    const m = measure(schema);
    if (m.count > MAX_SUBSCHEMAS || m.maxDepth > MAX_DEPTH) {
      out = new Error('Tool input schema exceeds the gateway limits');
    } else {
      try {
        const { $schema: _ignored, $id: _id, ...rest } = schema;
        out = this.ajv.compile(rest);
      } catch (err) {
        out = new Error(`Tool input schema cannot be compiled: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(hash, out);
    return out;
  }

  check(hash: string, schema: Record<string, unknown>, args: unknown): ArgCheck {
    const v = this.compile(hash, schema);
    if (v instanceof Error) return { ok: false, errors: [v.message] };
    if (v(args)) return { ok: true };
    return { ok: false, errors: (v.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`.trim()) };
  }
}
