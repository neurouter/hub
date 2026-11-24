import type { Kysely } from 'kysely';
import type { MainDB } from '../../db/schema.js';
import { searchTextOf } from '../../catalog/tool-hash.js';
import { ftsInsert, nextToolSeq } from '../../catalog/tools.repo.js';
import { newId } from '../../lib/ids.js';

export interface SeedTool {
  name: string;
  title?: string | null;
  description: string;
  inputSchema?: Record<string, unknown>;
  requiresApproval?: boolean;
}

/**
 * Inserts an owner, servers and active, pinned tools straight into the DB (with FTS rows), for
 * search / approvals unit tests that don't need a live upstream.
 */
export async function seedCatalog(db: Kysely<MainDB>, servers: Array<{ slug: string; name?: string; tools: SeedTool[] }>, now = Date.now()): Promise<{ ownerId: string; servers: Record<string, string>; tools: Record<string, string> }> {
  const ownerId = newId();
  await db.insertInto('users').values({ id: ownerId, email: `owner-${ownerId.slice(-6)}@x.test`, name: 'owner', oidc_issuer: null, oidc_subject: null, avatar_url: null, last_login_at: null, created_at: now, updated_at: now }).execute();
  const serverIds: Record<string, string> = {};
  const toolIds: Record<string, string> = {};
  for (const s of servers) {
    const sid = newId();
    serverIds[s.slug] = sid;
    await db.insertInto('servers').values({ id: sid, slug: s.slug, name: s.name ?? s.slug, owner_user_id: ownerId, url: `http://${s.slug}.test/mcp`, transport: 'streamable_http', auth_mode: 'none', icon_url: null, sync_interval_min: null, oauth_config: null, rate_limit: null, detected_era: null, protocol_version: null, server_info: null, capabilities: null, last_synced_at: now, created_by: null, created_at: now, updated_at: now }).execute();
    for (const t of s.tools) {
      const id = newId();
      const seq = await nextToolSeq(db);
      const exposed = `${s.slug}__${t.name}`;
      const inputSchema = t.inputSchema ?? { type: 'object' };
      const search_text = searchTextOf({ inputSchema });
      await db.insertInto('tools').values({ id, server_id: sid, seq, upstream_name: t.name, exposed_name: exposed, title: t.title ?? null, description: t.description, input_schema: JSON.stringify(inputSchema), output_schema: null, annotations: null, icons: null, execution: null, pinned_hash: 'h', pending_hash: null, pending_definition: null, status: 'active', enabled: 1, requires_approval: t.requiresApproval ? 1 : 0, approval_timeout_sec: null, rate_limit: null, search_text, first_seen_at: now, last_seen_at: now, approved_by: null, approved_at: null, created_at: now, updated_at: now }).execute();
      await ftsInsert(db, 'sqlite', { seq, exposed_name: exposed, title: t.title ?? null, description: t.description, search_text });
      toolIds[exposed] = id;
    }
  }
  return { ownerId, servers: serverIds, tools: toolIds };
}

const SERVICES: Array<{ slug: string; area: string; objects: string[] }> = [
  { slug: 'github', area: 'GitHub', objects: ['issue', 'pull request', 'repository', 'branch', 'release', 'comment', 'workflow run', 'gist'] },
  { slug: 'jira', area: 'Jira', objects: ['ticket', 'sprint', 'epic', 'board', 'worklog', 'comment', 'project', 'version'] },
  { slug: 'slack', area: 'Slack', objects: ['message', 'channel', 'reaction', 'reminder', 'user group', 'file', 'thread', 'bookmark'] },
  { slug: 'gdrive', area: 'Google Drive', objects: ['document', 'folder', 'spreadsheet', 'permission', 'presentation', 'comment', 'shortcut', 'revision'] },
  { slug: 'postgres', area: 'PostgreSQL', objects: ['table', 'index', 'query plan', 'schema', 'role', 'view', 'extension', 'backup'] },
  { slug: 'k8s', area: 'Kubernetes', objects: ['pod', 'deployment', 'service', 'namespace', 'config map', 'secret', 'ingress', 'cron job'] },
  { slug: 'aws', area: 'AWS', objects: ['s3 bucket', 'ec2 instance', 'lambda function', 'iam role', 'cloudwatch alarm', 'sqs queue', 'rds snapshot', 'route53 record'] },
  { slug: 'calendar', area: 'Google Calendar', objects: ['event', 'calendar', 'attendee', 'reminder', 'availability', 'meeting room', 'recurring event', 'invitation'] },
];
const VERBS: Array<{ verb: string; text: string }> = [
  { verb: 'create', text: 'Create a new' },
  { verb: 'get', text: 'Get details of a' },
  { verb: 'list', text: 'List all' },
  { verb: 'update', text: 'Update an existing' },
  { verb: 'delete', text: 'Permanently delete a' },
];

/** 8 services × 8 objects × 5 verbs = 320 synthetic tools with realistic names and descriptions. */
export function syntheticCatalog(): Array<{ slug: string; tools: SeedTool[] }> {
  return SERVICES.map((s) => ({
    slug: s.slug,
    tools: s.objects.flatMap((o) =>
      VERBS.map((v) => ({
        name: `${v.verb}_${o.replace(/\s+/g, '_')}`,
        description: `${v.text} ${o} in ${s.area}.`,
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: `${o} identifier` }, ...(v.verb === 'create' || v.verb === 'update' ? { fields: { type: 'object', description: `${o} fields to set` } } : {}) } },
      })),
    ),
  }));
}

/** Fixed 30-query evaluation set over `syntheticCatalog()` (step 8 acceptance: recall@3 ≥ 0.8). */
export const SEARCH_EVAL_SET: ReadonlyArray<readonly [query: string, expected: string]> = [
  ['open a new bug report in github', 'github__create_issue'],
  ['list pull requests on github', 'github__list_pull_request'],
  ['delete a git branch on github', 'github__delete_branch'],
  ['publish a github release', 'github__create_release'],
  ['show workflow runs', 'github__list_workflow_run'],
  ['create jira ticket', 'jira__create_ticket'],
  ['update a jira sprint', 'jira__update_sprint'],
  ['log work in jira worklog', 'jira__create_worklog'],
  ['post a chat message to slack', 'slack__create_message'],
  ['enumerate slack channels', 'slack__list_channel'],
  ['set a reminder in slack', 'slack__create_reminder'],
  ['share a google drive folder permission', 'gdrive__create_permission'],
  ['get a spreadsheet from google drive', 'gdrive__get_spreadsheet'],
  ['list document revisions in google drive', 'gdrive__list_revision'],
  ['explain a postgres query plan', 'postgres__get_query_plan'],
  ['drop a postgres table', 'postgres__delete_table'],
  ['list postgres extensions', 'postgres__list_extension'],
  ['restart kubernetes deployment by updating it', 'k8s__update_deployment'],
  ['show pods in kubernetes', 'k8s__list_pod'],
  ['create a kubernetes cron job', 'k8s__create_cron_job'],
  ['delete a kubernetes secret', 'k8s__delete_secret'],
  ['list s3 buckets', 'aws__list_s3_bucket'],
  ['start a new ec2 vm', 'aws__create_ec2_instance'],
  ['invoke details of a lambda function', 'aws__get_lambda_function'],
  ['remove a route53 dns record', 'aws__delete_route53_record'],
  ['schedule a calendar event', 'calendar__create_event'],
  ['check attendee availability', 'calendar__get_availability'],
  ['list meeting rooms', 'calendar__list_meeting_room'],
  ['cancel a recurring event', 'calendar__delete_recurring_event'],
  ['github__get_gist', 'github__get_gist'],
];
