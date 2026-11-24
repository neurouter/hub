import * as z from 'zod';
import { RedactionRuleType } from '../domain/enums.js';
import { Id, IdParams, Items, JsonObject } from './common.js';
import { endpoint } from './endpoint.js';

export const RedactionRule = z.object({
  id: Id,
  name: z.string(),
  type: RedactionRuleType,
  pattern: z.string(),
  replacement: z.string(),
  enabled: z.boolean(),
  order: z.number().int(),
  builtin: z.boolean(),
});
export type RedactionRule = z.infer<typeof RedactionRule>;

export const CreateRedactionRuleBody = z.object({
  name: z.string().trim().min(1).max(100),
  type: RedactionRuleType,
  pattern: z.string().min(1).max(1000),
  replacement: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  order: z.number().int().optional(),
});
export type CreateRedactionRuleBody = z.infer<typeof CreateRedactionRuleBody>;
/** Built-in rules accept only `enabled` / `order` (server enforces). */
export const UpdateRedactionRuleBody = CreateRedactionRuleBody.partial();
export type UpdateRedactionRuleBody = z.infer<typeof UpdateRedactionRuleBody>;

export const RedactionTestBody = z.object({ sample: JsonObject, rules: z.array(RedactionRule).optional() });
export type RedactionTestBody = z.infer<typeof RedactionTestBody>;
export const RedactionTestResult = z.object({
  redacted: JsonObject,
  matches: z.array(z.object({ path: z.array(z.string()), ruleId: Id })),
});
export type RedactionTestResult = z.infer<typeof RedactionTestResult>;

export const redactionEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/settings/redaction-rules', kind: 'json', access: ['auditor'],
    summary: 'Redaction rules', response: Items(RedactionRule),
  }),
  create: endpoint({
    method: 'POST', path: '/api/settings/redaction-rules', kind: 'json', status: 201, access: ['admin'],
    summary: 'Add a rule (422 on a bad or slow regex)', body: CreateRedactionRuleBody, response: RedactionRule,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/settings/redaction-rules/:id', kind: 'json', access: ['admin'],
    summary: 'Edit a rule (builtin: enabled/order only)', params: IdParams, body: UpdateRedactionRuleBody, response: RedactionRule,
  }),
  delete: endpoint({
    method: 'DELETE', path: '/api/settings/redaction-rules/:id', kind: 'empty', access: ['admin'],
    summary: 'Delete a non-builtin rule', params: IdParams,
  }),
  test: endpoint({
    method: 'POST', path: '/api/settings/redaction/test', kind: 'json', access: ['admin'],
    summary: 'Preview redaction on a sample', body: RedactionTestBody, response: RedactionTestResult,
  }),
} as const;
