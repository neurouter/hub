import type { GradeConfidence, GradeFlag, GradeSignal, GradeSubscore, GradeSubscoreKey, LetterGrade, PublisherTrust, QualityGrade } from '../api/library.js';
import type { DefinitionLint } from './definition-lint.js';

/**
 * Quality grade v1: plain code over observable signals, no model involved. Every point is shown
 * in the breakdown, so admins can see why a server got its grade (and publishers can't hide how).
 *
 * Rules:
 * - Five weighted sub-scores (0–1): connectivity 25, definitions 25, maintenance 20, hygiene 15,
 *   adoption 15. The grade is the weighted mean of the sub-scores that have data: unknown is left
 *   out, never counted as zero, so a new server isn't punished for having no history.
 * - Confidence = share of the weight that had data (<40 low, ≤75 medium, >75 high).
 * - Red flags cap the grade (e.g. injection-like text → at most D) instead of nudging it.
 * - Publisher trust is a separate badge, not part of the score.
 * - Popularity is log-scaled and capped; publisher-provided `_meta` is ignored.
 */
export const GRADE_VERSION = 1;

export const WEIGHTS: Record<GradeSubscoreKey, number> = { connectivity: 25, definitions: 25, maintenance: 20, hygiene: 15, adoption: 15 };
const LABELS: Record<GradeSubscoreKey, string> = {
  connectivity: 'Connectivity',
  definitions: 'Tool definitions',
  maintenance: 'Maintenance & stability',
  hygiene: 'Hygiene',
  adoption: 'Adoption',
};
const ORDER: LetterGrade[] = ['A', 'B', 'C', 'D', 'F'];

export interface GradeRemote {
  type: 'streamable-http' | 'sse';
  url: string;
  headers: Array<{ name: string; required: boolean; description: string | null }>;
}

/** Registry metadata (library entries, or the entry a gateway server was imported from). */
export interface RegistryFacts {
  name: string;
  namespace: string;
  status: 'active' | 'deprecated' | 'deleted';
  description: string;
  title: string | null;
  websiteUrl: string | null;
  repositoryUrl: string | null;
  remotes: GradeRemote[];
  hasPackages: boolean;
  publishedAt: number | null;
  /** Entries published under the same namespace. */
  namespaceCount: number;
  /** Distinct namespaces using exactly this description. */
  duplicateDescriptionCount: number;
  /** Other entries using the same remote URL. */
  sharedUrlCount: number;
}

export interface ConnectionFacts {
  ok: boolean;
  authRequired: boolean;
  oauthDiscovery: boolean;
  protocolVersion: string | null;
  latencyMs: number | null;
  toolCount: number | null;
  error: string | null;
}

export interface GithubFacts {
  found: boolean;
  archived: boolean;
  stars: number;
  pushedAt: number | null;
  license: string | null;
  ownerType: 'User' | 'Organization' | null;
  ownerLogin: string | null;
}

/** Our own evidence for a server registered in this gateway (the hardest to game). */
export interface RuntimeFacts {
  url: string;
  /** Health checks in the retention window (7 days). */
  checks: number;
  checksOk: number;
  medianLatencyMs: number | null;
  /** Definition changes seen by tool sync in the last 30 days. */
  definitionChanges30d: number;
  rejectedVersions: number;
  /** Distinct users and agents that called a tool in the last 30 days. */
  distinctCallers30d: number;
  /** Lifetime tool calls by those callers. */
  calls: number;
}

export interface GradeInput {
  now: number;
  registry?: RegistryFacts | null;
  connection?: ConnectionFacts | null;
  lint?: DefinitionLint | null;
  github?: GithubFacts | null;
  runtime?: RuntimeFacts | null;
}

/* ------------------------------------------------------------------ helpers */

const DAY = 86_400_000;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number) => Math.round(x * 1000) / 1000;
const ageDays = (now: number, t: number) => Math.max(0, Math.floor((now - t) / DAY));
/** log-scaled popularity: 0 → 0, `full` → 1, capped. */
const logScore = (n: number, full: number) => clamp01(Math.log10(n + 1) / Math.log10(full + 1));

function letter(score: number): LetterGrade {
  if (score >= 0.85) return 'A';
  if (score >= 0.7) return 'B';
  if (score >= 0.55) return 'C';
  if (score >= 0.4) return 'D';
  return 'F';
}

function worse(a: LetterGrade, b: LetterGrade): LetterGrade {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

/** Weighted mean of the signals that have a score. */
function combine(signals: Array<GradeSignal & { w: number }>): number | null {
  const scored = signals.filter((s) => s.score !== null);
  const total = scored.reduce((s, x) => s + x.w, 0);
  if (!total) return null;
  return round(scored.reduce((s, x) => s + x.w * (x.score as number), 0) / total);
}

const strip = (signals: Array<GradeSignal & { w: number }>): GradeSignal[] => signals.map(({ w: _w, ...s }) => s);

/** `com.example` → `example.com`; `io.github.user` → null (not a domain claim). */
export function namespaceDomain(namespace: string): string | null {
  if (namespace.startsWith('io.github.')) return null;
  const parts = namespace.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.reverse().join('.').toLowerCase();
}

export function githubNamespaceOwner(namespace: string): string | null {
  return namespace.startsWith('io.github.') ? namespace.slice('io.github.'.length).toLowerCase() || null : null;
}

export function githubRepo(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?(?:[#?].*)?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Host of an absolute http(s) URL (no `URL` global in this package: it runs in Node and browsers). */
function hostOf(url: string): string | null {
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

const isUnder = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/* ------------------------------------------------------------------ trust */

export function publisherTrust(reg: RegistryFacts, github: GithubFacts | null | undefined): { trust: PublisherTrust; reason: string } {
  const domain = namespaceDomain(reg.namespace);
  const hosts = reg.remotes.map((r) => hostOf(r.url)).filter((h): h is string => !!h && !h.includes('{'));
  if (domain) {
    if (!hosts.length) return { trust: 'known', reason: `The registry verified control of ${domain}; there is no remote endpoint to compare.` };
    if (hosts.every((h) => isUnder(h, domain))) return { trust: 'verified', reason: `The registry verified control of ${domain}, and the endpoint is on that domain.` };
    const other = hosts.find((h) => !isUnder(h, domain))!;
    return { trust: 'mismatch', reason: `The name claims ${domain}, but the endpoint is on ${other}. The registry does not check this.` };
  }
  const owner = githubNamespaceOwner(reg.namespace);
  const repo = githubRepo(reg.repositoryUrl);
  if (owner && repo && repo.owner.toLowerCase() === owner) {
    if (github?.found && github.ownerType === 'Organization') return { trust: 'verified', reason: `The GitHub organization ${repo.owner} published it and owns the repository.` };
    return { trust: 'known', reason: `The GitHub account ${repo.owner} published it and owns the repository.` };
  }
  if (owner) return { trust: 'unverified', reason: `Published by the GitHub account ${owner}, which does not own the linked repository (or none is linked).` };
  return { trust: 'unverified', reason: 'Nothing ties the name to the endpoint or the source code.' };
}

/* ------------------------------------------------------------------ sub-scores */

function connectivity(i: GradeInput, flags: GradeFlag[]): Array<GradeSignal & { w: number }> {
  const out: Array<GradeSignal & { w: number }> = [];
  const rt = i.runtime;
  if (rt && rt.checks >= 10) {
    const up = rt.checksOk / rt.checks;
    const upScore = up >= 0.995 ? 1 : up >= 0.98 ? 0.85 : up >= 0.95 ? 0.6 : up >= 0.9 ? 0.3 : 0;
    out.push({ label: 'Uptime (our health checks, 7 days)', value: `${pct(up)} of ${rt.checks.toLocaleString('en-US')} checks`, score: upScore, w: 3 });
    if (up < 0.9) flags.push({ code: 'unstable', severity: 'warn', message: `Answered only ${pct(up)} of health checks in the last 7 days.`, cap: 'C' });
    if (rt.medianLatencyMs !== null) {
      const l = rt.medianLatencyMs;
      out.push({ label: 'Median health-check latency', value: `${l} ms`, score: l < 500 ? 1 : l < 1500 ? 0.7 : l < 3000 ? 0.4 : 0.1, w: 1 });
    }
    return out;
  }
  const c = i.connection;
  if (!c) return out;
  if (c.ok) {
    out.push({ label: 'Connection without credentials', value: c.toolCount === null ? 'Connected' : `Connected, listed ${c.toolCount} tools`, score: 1, w: 3 });
  } else if (c.authRequired) {
    const declared = (i.registry?.remotes ?? []).some((r) => r.headers.length > 0);
    if (c.oauthDiscovery) out.push({ label: 'Connection without credentials', value: 'Requires sign-in; OAuth discovery works', score: 0.9, w: 3 });
    else if (declared) out.push({ label: 'Connection without credentials', value: 'Requires the declared header', score: 0.8, w: 3 });
    else {
      out.push({ label: 'Connection without credentials', value: 'Rejected, with no OAuth discovery and no declared header', score: 0.5, w: 3 });
      flags.push({ code: 'auth_undeclared', severity: 'info', message: 'The endpoint requires credentials, but the registry entry declares neither headers nor OAuth discovery.', cap: null });
    }
  } else {
    out.push({ label: 'Connection without credentials', value: c.error ? `Failed: ${c.error.slice(0, 120)}` : 'Failed', score: 0, w: 3 });
    flags.push({ code: 'unreachable', severity: 'warn', message: 'The endpoint did not answer the last check.', cap: 'D' });
  }
  if (c.latencyMs !== null && (c.ok || c.authRequired)) {
    const l = c.latencyMs;
    out.push({ label: 'Connect latency', value: `${l} ms`, score: l < 800 ? 1 : l < 2000 ? 0.7 : l < 5000 ? 0.4 : 0.1, w: 1 });
  }
  if (c.protocolVersion) {
    const modern = c.protocolVersion >= '2025-06-18';
    out.push({ label: 'Protocol version', value: c.protocolVersion, score: modern ? 1 : c.protocolVersion >= '2025-03-26' ? 0.7 : 0.4, w: 1 });
  }
  return out;
}

function definitions(i: GradeInput, flags: GradeFlag[]): Array<GradeSignal & { w: number }> {
  const l = i.lint;
  if (!l) return [];
  if (!l.tools.length) {
    flags.push({ code: 'no_tools', severity: 'warn', message: 'The server lists no tools.', cap: 'D' });
    return [{ label: 'Tools listed', value: '0', score: 0, w: 1 }];
  }
  const out: Array<GradeSignal & { w: number }> = [];
  const by = (pred: (issues: string[]) => boolean) => l.tools.filter((t) => pred(t.issues)).length;
  const n = l.tools.length;
  out.push({ label: 'Definition quality (0.6 × mean + 0.4 × worst tool)', value: `${Math.round((l.score ?? 0) * 100)} / 100 over ${n} tools`, score: l.score, w: 1 });
  const noDesc = by((x) => x.some((s) => s.startsWith('No description') || s.startsWith('Description')));
  out.push({ label: 'Tools with a useful description', value: `${n - noDesc} of ${n}`, score: null, w: 0 });
  const undocumented = by((x) => x.some((s) => s.includes('parameters have no description')));
  out.push({ label: 'Tools with every parameter documented', value: `${n - undocumented} of ${n}`, score: null, w: 0 });
  const annotated = by((x) => !x.some((s) => s.startsWith('No behaviour annotations')));
  out.push({ label: 'Tools with behaviour annotations', value: `${annotated} of ${n}`, score: null, w: 0 });
  if (n > 80) flags.push({ code: 'large_toolset', severity: 'info', message: `${n} tools: large toolsets crowd the model's context; consider exposing a subset.`, cap: null });
  if (l.injection.length) {
    const first = l.injection[0]!;
    flags.push({ code: 'injection_like', severity: 'danger', message: `Tool text reads like instructions to the model ("${first.match}" in ${first.tool}${l.injection.length > 1 ? ` and ${l.injection.length - 1} more` : ''}).`, cap: 'D' });
  }
  if (l.hiddenUnicode.length) flags.push({ code: 'hidden_unicode', severity: 'danger', message: `Invisible Unicode characters in ${l.hiddenUnicode.slice(0, 3).join(', ')}.`, cap: 'D' });
  if (l.contradictions.length) flags.push({ code: 'annotation_contradiction', severity: 'warn', message: `Marked read-only but named like a destructive action: ${l.contradictions.slice(0, 3).join(', ')}.`, cap: null });
  if (l.oversized.length) flags.push({ code: 'oversized_description', severity: 'warn', message: `Descriptions over 2,000 characters: ${l.oversized.slice(0, 3).join(', ')}.`, cap: null });
  return out;
}

function maintenance(i: GradeInput, flags: GradeFlag[]): Array<GradeSignal & { w: number }> {
  const out: Array<GradeSignal & { w: number }> = [];
  const g = i.github;
  if (g?.found) {
    if (g.archived) {
      out.push({ label: 'Repository', value: 'Archived', score: 0, w: 3 });
      flags.push({ code: 'archived', severity: 'warn', message: 'The source repository is archived.', cap: 'C' });
    } else if (g.pushedAt) {
      const d = ageDays(i.now, g.pushedAt);
      out.push({ label: 'Last push to the repository', value: d === 0 ? 'today' : `${d} days ago`, score: d <= 90 ? 1 : d <= 180 ? 0.8 : d <= 365 ? 0.5 : 0.2, w: 3 });
    }
  }
  const rt = i.runtime;
  if (rt) {
    const ch = rt.definitionChanges30d;
    out.push({ label: 'Definition changes seen in 30 days', value: String(ch), score: ch === 0 ? 1 : ch <= 3 ? 0.8 : 0.4, w: 2 });
    if (ch > 3) flags.push({ code: 'definition_churn', severity: 'warn', message: `Tool definitions changed ${ch} times in 30 days.`, cap: null });
    if (rt.rejectedVersions > 0) {
      out.push({ label: 'Definition versions rejected by your admins', value: String(rt.rejectedVersions), score: 0, w: 1 });
      flags.push({ code: 'rejected_definitions', severity: 'warn', message: `Your admins rejected ${rt.rejectedVersions} definition version(s) from this server.`, cap: null });
    }
  }
  if (i.registry?.status === 'deprecated') flags.push({ code: 'deprecated', severity: 'warn', message: 'The publisher marked this server deprecated.', cap: 'C' });
  if (i.registry?.status === 'deleted') flags.push({ code: 'deleted', severity: 'danger', message: 'The registry removed this server (usually spam, malware or abandonment).', cap: 'F' });
  return out;
}

const TEMPLATE_DESCRIPTIONS = new Set(['description of my mcp server', 'a model context protocol server', 'mcp server', 'todo', 'test', 'my mcp server']);

function hygiene(i: GradeInput, flags: GradeFlag[]): Array<GradeSignal & { w: number }> {
  const out: Array<GradeSignal & { w: number }> = [];
  const reg = i.registry;
  const urls = reg ? reg.remotes.map((r) => r.url) : i.runtime ? [i.runtime.url] : [];
  if (urls.length) {
    const https = urls.every((u) => u.startsWith('https://'));
    const placeholder = urls.some((u) => /^https?:\/\/[^/]*\{/.test(u));
    out.push({ label: 'HTTPS endpoint', value: https ? 'Yes' : 'No', score: https ? 1 : 0, w: 3 });
    if (!https && reg) flags.push({ code: 'plain_http', severity: 'warn', message: 'The endpoint is plain HTTP.', cap: 'D' });
    if (placeholder) flags.push({ code: 'placeholder_host', severity: 'warn', message: 'The endpoint host is a template placeholder.', cap: 'D' });
  }
  if (i.github?.found) out.push({ label: 'License', value: i.github.license ?? 'None', score: i.github.license && i.github.license !== 'NOASSERTION' ? 1 : 0, w: 3 });
  if (reg) {
    out.push({ label: 'Source repository linked', value: reg.repositoryUrl ? 'Yes' : 'No', score: reg.repositoryUrl ? 1 : 0, w: 2 });
    out.push({ label: 'Title or website', value: reg.title || reg.websiteUrl ? 'Yes' : 'No', score: reg.title || reg.websiteUrl ? 1 : 0, w: 1 });
    const headers = reg.remotes.flatMap((r) => r.headers);
    if (headers.length) {
      const documented = headers.filter((h) => h.description && h.description.trim().length >= 10).length;
      out.push({ label: 'Declared headers explained', value: `${documented} of ${headers.length}`, score: documented / headers.length, w: 1 });
    }
    const desc = reg.description.trim().toLowerCase();
    if (!desc || TEMPLATE_DESCRIPTIONS.has(desc)) flags.push({ code: 'template_description', severity: 'warn', message: 'The description is empty or a template default.', cap: 'D' });
    else if (reg.duplicateDescriptionCount >= 5) flags.push({ code: 'duplicate_description', severity: 'warn', message: `The same description is used by ${reg.duplicateDescriptionCount} publishers.`, cap: 'D' });
    if (reg.namespaceCount > 500) flags.push({ code: 'mass_publisher', severity: 'warn', message: `This publisher has ${reg.namespaceCount.toLocaleString('en-US')} servers in the registry (mass publishing).`, cap: 'D' });
    else if (reg.namespaceCount > 50) flags.push({ code: 'many_servers', severity: 'info', message: `This publisher has ${reg.namespaceCount} servers in the registry.`, cap: null });
    if (reg.sharedUrlCount > 3) flags.push({ code: 'shared_url', severity: 'info', message: `${reg.sharedUrlCount} other registry entries use the same endpoint URL.`, cap: null });
  }
  return out;
}

function adoption(i: GradeInput): Array<GradeSignal & { w: number }> {
  const rt = i.runtime;
  // inside the organization, real use replaces public popularity (much harder to game)
  if (rt && (rt.calls > 0 || rt.distinctCallers30d > 0)) {
    return [
      { label: 'Users and agents calling it (30 days)', value: String(rt.distinctCallers30d), score: logScore(rt.distinctCallers30d, 20), w: 2 },
      { label: 'Tool calls by those callers', value: rt.calls.toLocaleString('en-US'), score: logScore(rt.calls, 1000), w: 1 },
    ];
  }
  const g = i.github;
  if (g?.found) {
    const young = i.registry?.publishedAt !== null && i.registry?.publishedAt !== undefined && ageDays(i.now, i.registry.publishedAt) < 60;
    // a new server with few stars yet is unknown, not unpopular
    if (young && g.stars < 50) return [{ label: 'GitHub stars', value: `${g.stars} (published under 60 days ago; not scored)`, score: null, w: 1 }];
    return [{ label: 'GitHub stars (log scale, full marks at 500)', value: g.stars.toLocaleString('en-US'), score: logScore(g.stars, 500), w: 1 }];
  }
  return [];
}

/* ------------------------------------------------------------------ grade */

export function computeGrade(i: GradeInput): QualityGrade {
  const flags: GradeFlag[] = [];
  const parts: Record<GradeSubscoreKey, Array<GradeSignal & { w: number }>> = {
    connectivity: connectivity(i, flags),
    definitions: definitions(i, flags),
    maintenance: maintenance(i, flags),
    hygiene: hygiene(i, flags),
    adoption: adoption(i),
  };
  const subscores: GradeSubscore[] = (Object.keys(WEIGHTS) as GradeSubscoreKey[]).map((key) => ({
    key,
    label: LABELS[key],
    weight: WEIGHTS[key],
    score: combine(parts[key]),
    signals: strip(parts[key]),
  }));
  const known = subscores.filter((s) => s.score !== null);
  const knownWeight = known.reduce((s, x) => s + x.weight, 0);
  const score = knownWeight ? round(known.reduce((s, x) => s + x.weight * (x.score as number), 0) / knownWeight) : null;
  let confidence: GradeConfidence = knownWeight > 75 ? 'high' : knownWeight >= 40 ? 'medium' : 'low';
  // without seeing the server's tools, never more than medium
  if (confidence === 'high' && !i.lint) confidence = 'medium';

  const uncapped = score === null ? null : letter(score);
  let grade = uncapped;
  if (grade) for (const f of flags) if (f.cap) grade = worse(grade, f.cap);

  const trust = i.registry
    ? publisherTrust(i.registry, i.github)
    : { trust: 'unverified' as const, reason: 'Added by hand; not linked to a registry entry.' };
  if (trust.trust === 'mismatch') flags.push({ code: 'domain_mismatch', severity: 'warn', message: trust.reason, cap: null });

  const sources = [i.registry && 'registry', i.connection && 'check', i.lint && 'definitions', i.github?.found && 'github', i.runtime && 'gateway'].filter((x): x is string => !!x);
  const sev = { danger: 0, warn: 1, info: 2 } as const;
  flags.sort((a, b) => sev[a.severity] - sev[b.severity]);
  return {
    version: GRADE_VERSION,
    grade,
    score,
    uncappedGrade: uncapped !== grade ? uncapped : null,
    confidence,
    trust: trust.trust,
    trustReason: trust.reason,
    subscores,
    flags,
    sources,
    computedAt: new Date(i.now).toISOString(),
  };
}
