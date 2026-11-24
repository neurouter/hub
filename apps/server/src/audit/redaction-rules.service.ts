import type { Kysely } from 'kysely';
import type { CreateRedactionRuleBody, RedactionRule, RedactionTestBody, RedactionTestResult, UpdateRedactionRuleBody } from '@neurouter/shared';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { UserSubject } from '../identity/principal.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { fromBool, toBool } from '../lib/json.js';
import { BUILTIN_RULES, checkPattern, Redactor, type RedactionRuleDef } from './redact.js';
import type { AuditRecorder } from './recorder.js';

export const REDACTION_CHANNEL = 'redaction.changed';

type Row = { id: string; name: string; type: 'key' | 'regex'; pattern: string; replacement: string; enabled: 0 | 1; order: number; builtin: 0 | 1 };

const toRule = (r: Row): RedactionRule => ({ id: r.id, name: r.name, type: r.type, pattern: r.pattern, replacement: r.replacement, enabled: toBool(r.enabled), order: Number(r.order), builtin: toBool(r.builtin) });

/** Ordered redaction rules (`redaction_rules`, §9.2) with a compiled Redactor cached across flushes. */
export class RedactionRulesService {
  private cached: Redactor | null = null;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly audit: AuditRecorder,
    private readonly coord?: CoordinationStore,
  ) {
    coord?.subscribe(REDACTION_CHANNEL, () => {
      this.cached = null;
    });
  }

  /** Seeds missing built-ins (first boot, and new built-ins after upgrades). */
  async seedBuiltins(): Promise<number> {
    const existing = new Set((await this.db.selectFrom('redaction_rules').select('name').where('builtin', '=', 1).execute()).map((r) => r.name));
    const now = this.clock.now();
    let added = 0;
    for (const r of BUILTIN_RULES) {
      if (existing.has(r.name)) continue;
      await this.db
        .insertInto('redaction_rules')
        .values({ id: newId(), name: r.name, type: r.type, pattern: r.pattern, replacement: r.replacement, enabled: fromBool(r.enabled), order: r.order, builtin: 1, created_by: null, created_at: now, updated_at: now })
        .execute();
      added++;
    }
    if (added) this.cached = null;
    return added;
  }

  private async rows(): Promise<Row[]> {
    return (await this.db.selectFrom('redaction_rules').select(['id', 'name', 'type', 'pattern', 'replacement', 'enabled', 'order', 'builtin']).orderBy('order').orderBy('name').execute()) as Row[];
  }

  async list(): Promise<{ items: RedactionRule[] }> {
    return { items: (await this.rows()).map(toRule) };
  }

  /** The compiled redactor for the audit writer (built-ins when the table is empty). */
  async redactor(): Promise<Redactor> {
    if (this.cached) return this.cached;
    const rows = await this.rows();
    this.cached = rows.length ? new Redactor(rows.map(toRule) as RedactionRuleDef[]) : Redactor.builtins();
    return this.cached;
  }

  private async changed(): Promise<void> {
    this.cached = null;
    await this.coord?.publish(REDACTION_CHANNEL, {});
  }

  private validatePattern(type: 'key' | 'regex', pattern: string): void {
    const c = checkPattern(type, pattern);
    if (!c.ok) throw AppError.validation(c.reason === 'invalid' ? 'Invalid regular expression' : 'Regular expression is too slow', [{ path: ['pattern'], message: c.message, code: c.reason === 'invalid' ? 'invalid_regex' : 'regex_too_slow' }]);
  }

  private async get(id: string): Promise<Row> {
    const r = (await this.db.selectFrom('redaction_rules').select(['id', 'name', 'type', 'pattern', 'replacement', 'enabled', 'order', 'builtin']).where('id', '=', id).executeTakeFirst()) as Row | undefined;
    if (!r) throw AppError.notFound('Redaction rule');
    return r;
  }

  private async nameTaken(name: string, except?: string): Promise<boolean> {
    let q = this.db.selectFrom('redaction_rules').select('id').where('name', '=', name);
    if (except) q = q.where('id', '!=', except);
    return !!(await q.executeTakeFirst());
  }

  async create(body: CreateRedactionRuleBody, actor: UserSubject): Promise<RedactionRule> {
    this.validatePattern(body.type, body.pattern);
    if (await this.nameTaken(body.name)) throw AppError.conflict('A rule with this name already exists');
    const now = this.clock.now();
    const max = await this.db.selectFrom('redaction_rules').select((eb) => eb.fn.max('order').as('m')).executeTakeFirst();
    const row: Row = { id: newId(), name: body.name, type: body.type, pattern: body.pattern, replacement: body.replacement ?? '', enabled: fromBool(body.enabled ?? true), order: body.order ?? Number(max?.m ?? 0) + 10, builtin: 0 };
    await this.db.insertInto('redaction_rules').values({ ...row, created_by: actor.id, created_at: now, updated_at: now }).execute();
    await this.changed();
    const rule = toRule(row);
    this.audit.admin({ actorUserId: actor.id, action: 'redaction_rule.create', targetType: 'redaction_rule', targetId: row.id, after: rule });
    return rule;
  }

  async update(id: string, body: UpdateRedactionRuleBody, actor: UserSubject): Promise<RedactionRule> {
    const cur = await this.get(id);
    if (toBool(cur.builtin)) {
      const bad = (['name', 'type', 'pattern', 'replacement'] as const).filter((k) => body[k] !== undefined);
      if (bad.length) throw AppError.validation('Built-in rules can only be enabled, disabled or reordered', bad.map((k) => ({ path: [k], message: 'Not editable on a built-in rule', code: 'builtin_rule' })));
    }
    const type = body.type ?? cur.type;
    const pattern = body.pattern ?? cur.pattern;
    if (body.type !== undefined || body.pattern !== undefined) this.validatePattern(type, pattern);
    if (body.name !== undefined && body.name !== cur.name && (await this.nameTaken(body.name, id))) throw AppError.conflict('A rule with this name already exists');
    const next: Row = {
      ...cur,
      name: body.name ?? cur.name,
      type,
      pattern,
      replacement: body.replacement ?? cur.replacement,
      enabled: body.enabled === undefined ? cur.enabled : fromBool(body.enabled),
      order: body.order ?? cur.order,
    };
    await this.db.updateTable('redaction_rules').set({ name: next.name, type: next.type, pattern: next.pattern, replacement: next.replacement, enabled: next.enabled, order: next.order, updated_at: this.clock.now() }).where('id', '=', id).execute();
    await this.changed();
    const rule = toRule(next);
    this.audit.admin({ actorUserId: actor.id, action: 'redaction_rule.update', targetType: 'redaction_rule', targetId: id, before: toRule(cur), after: rule });
    return rule;
  }

  async delete(id: string, actor: UserSubject): Promise<void> {
    const cur = await this.get(id);
    if (toBool(cur.builtin)) throw AppError.conflict('Built-in rules cannot be deleted; disable them instead');
    await this.db.deleteFrom('redaction_rules').where('id', '=', id).execute();
    await this.changed();
    this.audit.admin({ actorUserId: actor.id, action: 'redaction_rule.delete', targetType: 'redaction_rule', targetId: id, before: toRule(cur) });
  }

  /** Preview: redacts a sample with the given rules (validated) or the current ones. */
  async test(body: RedactionTestBody): Promise<RedactionTestResult> {
    let redactor: Redactor;
    if (body.rules) {
      body.rules.forEach((r, i) => {
        const c = checkPattern(r.type, r.pattern);
        if (!c.ok) throw AppError.validation('Invalid rule', [{ path: ['rules', String(i), 'pattern'], message: c.message, code: c.reason === 'invalid' ? 'invalid_regex' : 'regex_too_slow' }]);
      });
      redactor = new Redactor(body.rules);
    } else {
      redactor = await this.redactor();
    }
    const res = redactor.redact(body.sample);
    return { redacted: res.value as Record<string, unknown>, matches: res.matches };
  }
}
