import type { Logger } from 'pino';
import { AuditRecorder } from './audit/recorder.js';
import { SqlAuditStore, type AuditStore } from './audit/store.js';
import { createArchiveStore, type ArchiveStore } from './audit/archive/index.js';
import { AuditService } from './audit/audit.service.js';
import { auditMacKey } from './audit/chain.js';
import { adminServerEnricher } from './audit/enrich.js';
import { NameResolver } from './audit/names.js';
import { RedactionRulesService } from './audit/redaction-rules.service.js';
import { SinkDispatcher } from './audit/sinks/dispatcher.js';
import { createOtlpLogProvider, OtelLogsSink, type LogProviderLike } from './audit/sinks/otel-logs.js';
import type { AuditSink } from './audit/sinks/sink.js';
import { WebhookSink } from './audit/sinks/webhook.js';
import type { AuditWriteContext } from './audit/writer.js';
import { newId } from './lib/ids.js';
import { Metrics } from './observability/metrics.js';
import { RollupAggregator } from './observability/rollups.js';
import { RollupQueries } from './observability/rollup-queries.js';
import { SessionsService } from './observability/sessions.service.js';
import { recordUsage } from './observability/usage.js';
import { AccessRequestsService } from './portal/access-requests.service.js';
import { PortalCatalogService } from './portal/catalog.service.js';
import { NameLookupService } from './identity/name-lookup.service.js';
import { ConnectionsService } from './portal/connections.service.js';
import { LoginService } from './auth/web/login.js';
import { OpenIdClientProvider, type OidcProvider } from './auth/web/oidc.js';
import { SessionService } from './auth/web/sessions.js';
import type { Config } from './config/load.js';
import type { CoordinationStore } from './coordination/types.js';
import type { Databases } from './db/index.js';
import { AgentsService } from './identity/agents.service.js';
import { GroupsService } from './identity/groups.service.js';
import { UsersService } from './identity/users.service.js';
import type { Clock } from './lib/clock.js';
import { AclService } from './policy/acl-cache.js';
import { BuiltinSecretProvider } from './secrets/builtin.provider.js';
import { EnvelopeService } from './secrets/envelope.service.js';
import { EnvKeyring } from './secrets/keyring.js';
import { SettingsService } from './settings/settings.service.js';
import { SettingsApi } from './settings/settings.api.js';
import { CatalogService } from './catalog/catalog.service.js';
import { CatalogQueries } from './catalog/queries.js';
import { HealthService } from './catalog/health.js';
import { IconService } from './catalog/icons.js';
import { ServersService } from './catalog/servers.service.js';
import { ToolSyncService } from './catalog/tool-sync.js';
import { ToolsService } from './catalog/tools.service.js';
import type { CatalogEvents } from './catalog/events.js';
import { JobsService } from './jobs/jobs.service.js';
import { LibraryService } from './library/library.service.js';
import { createSafeFetch, type FetchLike } from './lib/net/safe-fetch.js';
import type { NetPolicy } from './lib/net/ssrf-guard.js';
import { CredentialResolver } from './upstream/credentials.js';
import { UpstreamPool, type UpstreamServer } from './upstream/pool.js';
import { McpAuthenticator } from './auth/mcp/authenticate.js';
import type { ApprovalGate } from './gateway/approval-gate.js';
import { ApprovalsService } from './policy/approvals/approvals.service.js';
import { ApprovalHold } from './policy/approvals/hold.js';
import { ApprovalStreamHub } from './policy/approvals/stream.js';
import { ArgValidator } from './gateway/arg-validate.js';
import { GatewayPipeline } from './gateway/call-pipeline.js';
import { CoordinationEventBus } from './gateway/event-bus.js';
import { GrantsService } from './policy/grants.service.js';
import { RateLimiter } from './policy/rate-limit/limiter.js';
import { LeaseRateLimitStore, MemoryRateLimitStore, PgBucketExecutor } from './policy/rate-limit/stores.js';
import { KeywordIndex } from './search/keyword-index.js';
import { ToolSearchService } from './search/search.service.js';
import { disabledEmbedder, WorkerEmbedder, type Embedder } from './search/embedder.js';
import { SearchIndexer } from './search/indexer.js';
import { createVectorIndex } from './search/vector-index.js';
import { AuthorizationService } from './oauth/authorize.js';
import { CIMD_MAX_BYTES, CIMD_TIMEOUT_MS, CimdResolver } from './oauth/cimd.js';
import { OAuthClientsService } from './oauth/clients.service.js';
import { OAuthTokensService } from './oauth/tokens.service.js';
import { UpstreamOAuthService } from './upstream-oauth/upstream-oauth.service.js';

export interface ServiceInputs {
  config: Config;
  logger: Logger;
  dbs: Databases;
  /** Defaults to the SQL store on the audit DB, wired to settings, redaction, rollups and metrics. */
  auditStore?: AuditStore;
  clock: Clock;
  coordination: CoordinationStore;
  version: string;
  /** Override the OIDC provider (tests); default builds openid-client from OIDC_* env. */
  oidcProvider?: OidcProvider | null;
  /** Override upstream MCP fetch (tests: FakeUpstream.fetch); default is the SSRF-guarded undici fetch. */
  upstreamFetch?: (server: UpstreamServer) => FetchLike;
  /** Override strict outbound fetch (icons, OIDC test, CIMD). */
  outboundFetch?: FetchLike;
  /** Override the CIMD fetch (defaults to `outboundFetch` when that is overridden, else a no-redirect 5 KB strict fetch). */
  cimdFetch?: FetchLike;
  /** Human-approval hold override (tests); default is the cross-replica hold (step 9). */
  approvals?: ApprovalGate;
  /** Archive store override (tests); default from AUDIT_ARCHIVE_URL. */
  archive?: ArchiveStore | null;
  /** OTel logs provider override for the audit sink (tests). */
  otelLogProvider?: () => Promise<LogProviderLike>;
  /** prom-client default process metrics (off in tests to keep registries small). */
  defaultMetrics?: boolean;
  /** Library registry + GitHub API fetch override (tests). */
  libraryFetch?: FetchLike;
  /** Library connection-check fetch override (tests); default is a strict-policy fetch. */
  libraryProbeFetch?: FetchLike;
  /** Backoff sleep for registry retries (tests). */
  librarySleep?: (ms: number) => Promise<void>;
  /** Embedding model override (tests: FakeEmbedder / disabled); default is the worker-thread model from EMBEDDINGS_*. */
  embedder?: Embedder;
}

export function upstreamPolicy(config: Config): NetPolicy {
  const allowPrivate = config.env.UPSTREAM_ALLOW_PRIVATE_NETWORKS;
  return { allowPrivate, denyCidrs: config.env.UPSTREAM_DENY_CIDRS, allowHttp: allowPrivate ? 'always' : config.env.OUTBOUND_ALLOW_HTTP_LOOPBACK ? 'loopback' : 'never' };
}

export function outboundPolicy(config: Config): NetPolicy {
  return { allowPrivate: config.env.OUTBOUND_ALLOW_PRIVATE_NETWORKS, denyCidrs: config.env.UPSTREAM_DENY_CIDRS, allowHttp: config.env.OUTBOUND_ALLOW_HTTP_LOOPBACK ? 'loopback' : 'never' };
}

/** Composition root: constructs services with explicit dependencies (no DI framework, backend §1.2). */
export function createServices(input: ServiceInputs) {
  const { config, logger, dbs, clock, coordination: coord } = input;
  const db = dbs.main.db;
  const settings = new SettingsService(db, clock, coord);
  const keyring = new EnvKeyring(config.masterKeys, config.activeKeyId);

  /* ---------------------------------------------------------------- audit + observability (steps 5–6) */
  const metrics = new Metrics({ defaultMetrics: input.defaultMetrics ?? true });
  const rollups = new RollupAggregator(dbs.audit.db, dbs.audit.dialect, logger);
  let redactionRules: RedactionRulesService | null = null;
  let failClosed = true;
  let ftsEnabled = true;
  let installId: string | null = null;
  const writeContext = async (): Promise<AuditWriteContext> => {
    const [keys, full, maxBytes, idle, fc, fts, toolLabel] = await Promise.all([
      settings.get('auditSearchParamKeys'),
      settings.get('auditStoreFullOutput'),
      settings.get('auditFullOutputMaxBytes'),
      settings.get('sessionIdleMinutes'),
      settings.get('auditFailClosed'),
      settings.get('auditFtsEnabled'),
      settings.get('metricsToolLabel'),
    ]);
    failClosed = fc;
    ftsEnabled = fts;
    metrics.toolLabel = toolLabel;
    installId ??= (await settings.get('installId')) ?? (await settings.setIfAbsent('installId', newId()));
    return { redactor: await redactionRules!.redactor(), searchParamKeys: keys, storeFullOutput: full, fullOutputMaxBytes: maxBytes, sessionIdleMs: idle * 60_000, installId: installId! };
  };
  const archive = input.archive !== undefined ? input.archive : createArchiveStore(config.env.AUDIT_ARCHIVE_URL);
  const auditStore: AuditStore =
    input.auditStore ??
    new SqlAuditStore(dbs.audit.db, dbs.audit.dialect, {
      clock,
      log: logger,
      context: writeContext,
      enrich: adminServerEnricher(db),
      failClosed: () => failClosed,
      ftsEnabled: () => ftsEnabled,
      mac: {
        signer: () => ({ keyId: keyring.activeKekId, key: auditMacKey(keyring.derivationKey()) }),
        keyFor: (kid) => (keyring.has(kid) ? auditMacKey(keyring.derivationKey(kid)) : null),
      },
      archive,
      onCommitted: (rows) => {
        rollups.add(rows);
        metrics.observeAudit(rows);
        void recordUsage(db, rows).catch((err: unknown) => logger.warn({ err }, 'tool usage stats update failed'));
      },
      hooks: {
        queueDepth: (n) => metrics.auditQueueDepth.set(n),
        dropped: () => metrics.auditDropped.inc(),
        flushed: (sec) => metrics.auditFlush.observe(sec),
      },
    });
  const audit = new AuditRecorder(auditStore, clock, logger);
  redactionRules = new RedactionRulesService(db, clock, audit, coord);
  const envelope = new EnvelopeService(db, keyring, clock);
  const secrets = new BuiltinSecretProvider(db, envelope, clock);
  const sessions = new SessionService(db, clock, {
    cookieName: config.cookieNames.session,
    secure: config.publicUrl.startsWith('https://'),
    ttlMs: config.env.SESSION_TTL_HOURS * 3_600_000,
    idleMs: config.env.SESSION_IDLE_MINUTES * 60_000,
  });
  const oidcProvider: OidcProvider | null =
    input.oidcProvider !== undefined
      ? input.oidcProvider
      : config.env.OIDC_ISSUER && config.env.OIDC_CLIENT_ID && config.env.OIDC_CLIENT_SECRET
        ? new OpenIdClientProvider({ issuer: config.env.OIDC_ISSUER, clientId: config.env.OIDC_CLIENT_ID, clientSecret: config.env.OIDC_CLIENT_SECRET, allowInsecure: !config.isProduction && config.env.OIDC_ISSUER.startsWith('http://') })
        : null;
  const login = new LoginService(
    db,
    clock,
    envelope,
    settings,
    audit,
    {
      redirectUri: `${config.publicUrl}/api/auth/callback`,
      scopes: config.env.OIDC_SCOPES,
      groupsClaim: config.env.OIDC_GROUPS_CLAIM,
      autoCreateGroups: config.env.OIDC_GROUP_AUTO_CREATE,
      allowedEmailDomains: config.env.OIDC_ALLOWED_EMAIL_DOMAINS,
      bootstrapAdminEmail: config.env.BOOTSTRAP_ADMIN_EMAIL ?? null,
    },
    oidcProvider,
  );
  const acl = new AclService(db, clock, coord);
  const users = new UsersService(db, clock, audit, coord);
  const groups = new GroupsService(db, clock, audit, () => acl.aclChanged());
  const agents = new AgentsService(db, clock, config.hashPepper, audit, acl, coord);


  /* ---------------------------------------------------------------- catalog (step 3) */
  const closers: Array<() => Promise<void>> = [];
  let upstreamFetch = input.upstreamFetch;
  if (!upstreamFetch) {
    const f = createSafeFetch({ policy: upstreamPolicy(config), maxBytes: 16 * 1024 * 1024, connectTimeoutMs: 5000, maxRedirects: 3 });
    closers.push(() => f.close());
    upstreamFetch = () => f;
  }
  let outboundFetch = input.outboundFetch;
  if (!outboundFetch) {
    const f = createSafeFetch({ policy: outboundPolicy(config), maxBytes: 256 * 1024, timeoutMs: 5000, maxRedirects: 3 });
    closers.push(() => f.close());
    outboundFetch = f;
  }
  const bus = new CoordinationEventBus(coord);
  /* ---------------------------------------------------------------- search (step 8) */
  let indexer: SearchIndexer | null = null;
  const embedder: Embedder =
    input.embedder ??
    (config.env.EMBEDDINGS_ENABLED
      ? new WorkerEmbedder({ model: config.env.EMBEDDINGS_MODEL, dtype: config.env.EMBEDDINGS_DTYPE, dims: config.env.EMBEDDINGS_DIMS, modelsDir: config.modelsDir, allowRemote: config.env.EMBEDDINGS_ALLOW_REMOTE, log: logger, onReady: () => indexer?.kick() })
      : disabledEmbedder(config.env.EMBEDDINGS_MODEL, config.env.EMBEDDINGS_DIMS));
  const vectorIndex = createVectorIndex(db, dbs.main.dialect);
  indexer = new SearchIndexer({ db, embedder, vectors: vectorIndex, clock, coord, log: logger });
  const events: CatalogEvents = {
    serversChanged: async () => {
      await acl.catalogChanged();
      bus.publish({ kind: 'tools_list_changed' });
    },
    toolsChanged: async () => {
      await acl.catalogChanged();
      bus.publish({ kind: 'tools_list_changed' });
      indexer?.kick();
    },
  };
  const jobs = new JobsService(db, clock, logger);
  const credentials = new CredentialResolver(db, secrets, envelope, clock);
  let servers: ServersService | null = null;
  let health: HealthService | null = null;
  const pool = new UpstreamPool({
    clock,
    credentials,
    fetchFor: upstreamFetch,
    logger,
    onEra: (serverId, info) => void servers?.recordEra(serverId, info).catch((err: unknown) => logger.warn({ err }, 'failed to record upstream era')),
    onCircuit: (serverId, open) => {
      if (open) void health?.markDown(serverId, 'circuit open').catch(() => {});
    },
  });
  servers = new ServersService({ db, clock, secrets, audit, pool, events, upstreamPolicy: upstreamPolicy(config), publicUrl: config.publicUrl });
  health = new HealthService(db, clock, pool);
  const icons = new IconService(db, clock, outboundFetch);
  const toolSync = new ToolSyncService(db, dbs.main.dialect, clock, pool, audit, () => events.toolsChanged());
  const tools = new ToolsService(db, dbs.main.dialect, clock, audit, events);
  const catalogQueries = new CatalogQueries(db);
  const catalog = new CatalogService({ db, clock, jobs, toolSync, health, icons, settings, logger });


  /* ---------------------------------------------------------------- gateway (step 4) */
  const grants = new GrantsService(db, clock, acl, audit);
  const rateLimitStore =
    coord.backend === 'postgres' && dbs.main.dialect === 'postgres' ? new LeaseRateLimitStore(new PgBucketExecutor(db), clock) : (coord.rateLimit ?? new MemoryRateLimitStore(clock));
  coord.subscribe('ratelimit.changed', () => (rateLimitStore as { reset?: () => void }).reset?.());
  const limiter = new RateLimiter(rateLimitStore, settings);
  const authenticator = new McpAuthenticator(db, clock, { pepper: config.hashPepper, resourceUri: config.resourceUri }, coord);
  const search = new ToolSearchService(db, new KeywordIndex(db, dbs.main.dialect), vectorIndex, embedder, logger);
  /* ---------------------------------------------------------------- approvals (step 9) */
  const approvals = new ApprovalsService(db, clock, coord, settings, audit);
  const approvalStream = new ApprovalStreamHub(coord, approvals, logger);
  const approvalHold =
    input.approvals ??
    new ApprovalHold({
      db,
      clock,
      coord,
      settings,
      approvals,
      instanceId: config.instanceId,
      redact: async (args) => {
        const res = (await redactionRules!.redactor()).redact(args);
        return (res.value && typeof res.value === 'object' && !Array.isArray(res.value) ? res.value : { value: res.value }) as Record<string, unknown>;
      },
      onWait: (outcome, sec) => metrics.approvalWait.observe({ outcome }, sec),
    });
  const pipeline = new GatewayPipeline({ db, clock, acl, pool, limiter, args: new ArgValidator(), search, audit, keyring, approvals: approvalHold, publicUrl: config.publicUrl });

  /* ---------------------------------------------------------------- OAuth AS + per-user upstream OAuth (step 10) */
  let cimdFetch = input.cimdFetch ?? input.outboundFetch;
  if (!cimdFetch) {
    const f = createSafeFetch({ policy: outboundPolicy(config), maxBytes: CIMD_MAX_BYTES, timeoutMs: CIMD_TIMEOUT_MS, redirectsAreErrors: true });
    closers.push(() => f.close());
    cimdFetch = f;
  }
  const oauthClients = new OAuthClientsService(db, clock, new CimdResolver(cimdFetch, () => clock.now()), settings, config.hashPepper, audit, coord);
  const oauthTokens = new OAuthTokensService(db, clock, coord, audit, { pepper: config.hashPepper, resourceUri: config.resourceUri, accessTtlSec: config.env.OAUTH_ACCESS_TOKEN_TTL_SEC, refreshTtlDays: config.env.OAUTH_REFRESH_TOKEN_TTL_DAYS });
  const authorization = new AuthorizationService(db, clock, oauthClients, oauthTokens, audit, { issuer: config.publicUrl, resourceUri: config.resourceUri, pepper: config.hashPepper });
  const upstreamFetchFn = upstreamFetch;
  const upstreamOAuth = new UpstreamOAuthService({
    db,
    clock,
    envelope,
    secrets,
    acl,
    coord,
    audit,
    credentials,
    fetchFor: (server) => upstreamFetchFn({ id: server.id, name: server.id, url: server.url, transport: 'streamable_http', authMode: 'user_oauth', timeoutMs: 10_000 }),
    publicUrl: config.publicUrl,
    orgName: config.env.ORG_NAME,
    pepper: config.hashPepper,
    log: logger,
    // Q7: the first connected owner (or user) becomes the sync user; sync right away
    onConnected: (serverId) => void toolSync.sync(serverId, 'manual').catch((err: unknown) => logger.warn({ err, serverId }, 'initial sync after first upstream connection failed')),
    onTokensChanged: (serverId, userId) => pool.dropIdentity(serverId, userId),
  });

  /* ---------------------------------------------------------------- audit REST, sinks, observability, portal */
  const names = new NameResolver(db);
  const auditService = new AuditService(auditStore, names, jobs, audit, clock);
  const rollupQueries = new RollupQueries(dbs.audit.db, names, auditStore, () => clock.now());
  const sessionsService = new SessionsService(dbs.audit.db, dbs.audit.dialect, auditStore, names, clock);
  let otelProvider: Promise<LogProviderLike> | null = null;
  const sinks = async (): Promise<AuditSink[]> => {
    const cfg = await settings.get('auditSinks');
    const out: AuditSink[] = [];
    if (cfg.webhook.enabled && cfg.webhook.url) out.push(webhookSink(cfg.webhook.url, cfg.webhook.secretRef));
    if (cfg.otelLogs.enabled) {
      otelProvider ??= (input.otelLogProvider ?? createOtlpLogProvider)();
      out.push(new OtelLogsSink(await otelProvider));
    }
    return out;
  };
  const webhookSink = (url: string, secretRef: string | null) =>
    new WebhookSink({ url, fetch: outboundFetch!, now: () => clock.now(), secret: async () => (secretRef ? (await secrets.get({ id: secretRef })).toString('utf8') : null) });
  const sinkDispatcher = new SinkDispatcher({ db: dbs.audit.db, store: auditStore, sinks, clock, log: logger });
  const accessRequests = new AccessRequestsService(db, clock, grants, acl, audit);
  const portalCatalog = new PortalCatalogService(db, clock, acl, settings, search);
  const nameLookup = new NameLookupService(db, portalCatalog);
  const connections = new ConnectionsService(db, clock, acl, audit);
  metrics.beforeRender = async () => {
    const rows = await db.selectFrom('servers as s').leftJoin('server_health as h', 'h.server_id', 's.id').select(['s.slug', 'h.status']).where('s.status', '!=', 'disabled').execute();
    metrics.upstreamUp.reset();
    for (const r of rows) metrics.upstreamUp.set({ server: r.slug }, r.status === 'up' || r.status === 'degraded' ? 1 : 0);
    metrics.approvalsPending.set(await approvals.pendingCount());
    metrics.auditQueueDepth.set(auditStore.stats().queueDepth);
  };

  let libraryFetch = input.libraryFetch;
  if (!libraryFetch) {
    const f = createSafeFetch({ policy: outboundPolicy(config), maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000, maxRedirects: 3 });
    closers.push(() => f.close());
    libraryFetch = f;
  }
  let libraryProbeFetch = input.libraryProbeFetch;
  if (!libraryProbeFetch) {
    const f = createSafeFetch({ policy: outboundPolicy(config), maxBytes: 4 * 1024 * 1024, connectTimeoutMs: 5000, maxRedirects: 3 });
    closers.push(() => f.close());
    libraryProbeFetch = f;
  }
  const library = new LibraryService({
    db,
    dialect: dbs.main.dialect,
    clock,
    settings,
    secrets,
    audit,
    coord,
    fetch: libraryFetch,
    probeFetch: libraryProbeFetch,
    probePolicy: outboundPolicy(config),
    log: logger,
    version: input.version,
    ...(input.librarySleep ? { sleep: input.librarySleep } : {}),
  });

  const settingsApi = new SettingsApi(settings, secrets, audit, { otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null, outboundPolicy: outboundPolicy(config) });

  rollups.start();
  const shutdown = async (): Promise<void> => {
    bus.close();
    approvalStream.close();
    indexer?.close();
    await embedder.close().catch(() => {});
    await jobs.idle();
    await pool.close();
    for (const c of closers) await c();
    await auditStore.close(10_000).catch((err: unknown) => logger.error({ err }, 'audit flush on shutdown failed'));
    await rollups.stop().catch((err: unknown) => logger.error({ err }, 'rollup flush on shutdown failed'));
    if (otelProvider) await (await otelProvider).shutdown().catch(() => {});
  };
  return { config, logger, clock, dbs, coord, version: input.version, auditStore, audit, metrics, rollups, redactionRules: redactionRules!, names, auditService, rollupQueries, sessionsService, sinkDispatcher, webhookSink, archive, accessRequests, portalCatalog, nameLookup, connections, settings, keyring, envelope, secrets, sessions, oidcProvider, login, acl, users, groups, agents, jobs, credentials, pool, servers, health, icons, toolSync, tools, catalog, catalogQueries, outboundFetch, events, bus, grants, limiter, rateLimitStore, authenticator, search, embedder, vectorIndex, indexer: indexer!, approvals, approvalStream, approvalHold, oauthClients, oauthTokens, authorization, upstreamOAuth, pipeline, settingsApi, library, shutdown };
}

export type Services = ReturnType<typeof createServices>;

/** Boot-time tasks (seed role mappings, bootstrap admin). */
export async function initServices(s: Services): Promise<void> {
  await s.redactionRules.seedBuiltins();
  if (!(await s.settings.get('installId'))) await s.settings.setIfAbsent('installId', newId());
  const parts = await s.auditStore.maintainPartitions();
  for (const f of parts.failed) s.logger.warn({ partition: f.name, error: f.error }, 'audit partition could not be created');
  await s.settings.seedRoleMappings(s.config.env.OIDC_GROUPS_CLAIM, s.config.env.OIDC_ADMIN_GROUPS, s.config.env.OIDC_AUDITOR_GROUPS);
  const boot = await s.login.ensureBootstrapAdmin();
  if (boot === 'created') s.logger.info({ email: s.config.env.BOOTSTRAP_ADMIN_EMAIL }, 'bootstrap admin pre-provisioned');
}
