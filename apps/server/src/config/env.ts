import * as z from 'zod';

/** "true"/"false"/"1"/"0"/"yes"/"no" (env strings) → boolean. */
export const zBool = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  return v;
}, z.boolean());

/** Comma-separated list → trimmed, non-empty strings. */
export const zCsv = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string()),
);

/** Empty strings in env files mean "unset". */
const opt = <T extends z.ZodType>(s: T) => z.preprocess((v) => (v === '' ? undefined : v), s.optional());

export const MASTER_KEY_BYTES = 32;

/** Parses `"k1:<base64 32B>[,k2:<base64 32B>]"`. Throws with a readable message. */
export function parseMasterKeys(value: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const part of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0) throw new Error('each key must look like "<id>:<base64>"');
    const id = part.slice(0, i);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`invalid key id "${id}"`);
    const key = Buffer.from(part.slice(i + 1), 'base64');
    if (key.length !== MASTER_KEY_BYTES) throw new Error(`key "${id}" must decode to ${MASTER_KEY_BYTES} bytes (got ${key.length})`);
    if (out.has(id)) throw new Error(`duplicate key id "${id}"`);
    out.set(id, key);
  }
  if (out.size === 0) throw new Error('at least one key is required');
  return out;
}

/** Env schema (backend plan §3.1 + approved addendum: AUDIT_DATABASE_URL, AUDIT_ARCHIVE_URL). */
export const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    /** e.g. https://mcp.acme.internal (no trailing slash). Resource URI = PUBLIC_URL + '/mcp'. Defaults to http://localhost:PORT outside production. */
    PUBLIC_URL: opt(z.url()),
    TRUST_PROXY: z.string().default('loopback'),
    INSTANCE_ID: opt(z.string().max(100)),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: zBool.default(false),
    ORG_NAME: z.string().default('Neurouter'),

    DATABASE_URL: z.string().min(1).default('sqlite:./data/neurouter.db'),
    /** Optional separate DB for audit, sessions and metric rollups. Defaults to DATABASE_URL. */
    AUDIT_DATABASE_URL: opt(z.string().min(1)),
    /** Optional archive target for retention (`file:`, `s3://`, `gs://`, `azblob://`). */
    AUDIT_ARCHIVE_URL: opt(z.string().min(1)),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
    AUDIT_DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
    MIGRATE_ON_START: zBool.default(true),

    NEUROUTER_MASTER_KEYS: opt(z.string()),
    NEUROUTER_ACTIVE_KEY_ID: opt(z.string()),
    HASH_PEPPER: opt(z.string().min(32, 'HASH_PEPPER must be at least 32 characters')),

    OIDC_ISSUER: opt(z.url()),
    OIDC_CLIENT_ID: opt(z.string()),
    OIDC_CLIENT_SECRET: opt(z.string()),
    OIDC_DISPLAY_NAME: z.string().default('Single sign-on'),
    OIDC_SCOPES: z.string().default('openid email profile'),
    OIDC_GROUPS_CLAIM: z.string().default('groups'),
    OIDC_ADMIN_GROUPS: zCsv.default([]),
    OIDC_AUDITOR_GROUPS: zCsv.default([]),
    OIDC_ALLOWED_EMAIL_DOMAINS: zCsv.default([]),
    OIDC_GROUP_AUTO_CREATE: zBool.default(false),
    BOOTSTRAP_ADMIN_EMAIL: opt(z.email()),
    AUTH_DEV_LOGIN: zBool.default(false),
    SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
    SESSION_IDLE_MINUTES: z.coerce.number().positive().default(120),

    MCP_ALLOWED_ORIGINS: zCsv.default([]),
    OAUTH_ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(3600),
    OAUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    COORDINATION_BACKEND: z.enum(['auto', 'memory', 'postgres']).default('auto'),

    EMBEDDINGS_ENABLED: zBool.default(true),
    EMBEDDINGS_MODEL: z.string().default('onnx-community/granite-embedding-small-english-r2-ONNX'),
    EMBEDDINGS_DTYPE: z.enum(['fp32', 'fp16', 'q8', 'q4']).default('q8'),
    EMBEDDINGS_DIMS: z.coerce.number().int().positive().default(384),
    MODELS_DIR: z.string().default('./models'),
    EMBEDDINGS_ALLOW_REMOTE: zBool.default(true),

    UPSTREAM_ALLOW_PRIVATE_NETWORKS: zBool.default(true),
    UPSTREAM_DENY_CIDRS: zCsv.default(['169.254.0.0/16', 'fd00:ec2::/32']),
    OUTBOUND_ALLOW_PRIVATE_NETWORKS: zBool.default(false),
    OUTBOUND_ALLOW_HTTP_LOOPBACK: zBool.default(false),
    HTTPS_PROXY: opt(z.string()),

    METRICS_ENABLED: zBool.default(true),
    METRICS_TOKEN: opt(z.string()),
    OTEL_SDK_DISABLED: zBool.default(true),
    /** Built web app. Relative paths resolve against the server package directory. */
    WEB_DIST_DIR: z.string().default('../web/dist'),
    /** Serve WEB_DIST_DIR. Defaults to true in production only (in dev Vite serves the SPA). */
    SERVE_WEB: opt(zBool),
  })
  .superRefine((e, ctx) => {
    const prod = e.NODE_ENV === 'production';
    if (prod && !e.PUBLIC_URL) ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'PUBLIC_URL is required in production' });
    if (prod && e.PUBLIC_URL && !e.PUBLIC_URL.startsWith('https://'))
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'PUBLIC_URL must be https in production' });
    if (e.PUBLIC_URL?.endsWith('/')) ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'PUBLIC_URL must not end with a slash' });
    if (e.AUTH_DEV_LOGIN && e.NODE_ENV !== 'development')
      ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_LOGIN'], message: 'AUTH_DEV_LOGIN is only allowed when NODE_ENV=development' });
    const oidcSet = [e.OIDC_ISSUER, e.OIDC_CLIENT_ID, e.OIDC_CLIENT_SECRET].filter(Boolean).length;
    if (oidcSet > 0 && oidcSet < 3)
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set together' });
    if (prod && oidcSet < 3)
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required in production' });
    if (prod) {
      for (const k of ['NEUROUTER_MASTER_KEYS', 'NEUROUTER_ACTIVE_KEY_ID', 'HASH_PEPPER'] as const)
        if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required in production` });
    }
    if (e.NEUROUTER_MASTER_KEYS) {
      try {
        const keys = parseMasterKeys(e.NEUROUTER_MASTER_KEYS);
        if (e.NEUROUTER_ACTIVE_KEY_ID && !keys.has(e.NEUROUTER_ACTIVE_KEY_ID))
          ctx.addIssue({ code: 'custom', path: ['NEUROUTER_ACTIVE_KEY_ID'], message: 'NEUROUTER_ACTIVE_KEY_ID must name one of NEUROUTER_MASTER_KEYS' });
      } catch (err) {
        ctx.addIssue({ code: 'custom', path: ['NEUROUTER_MASTER_KEYS'], message: (err as Error).message });
      }
    }
    if (!/^(sqlite:|postgres:\/\/|postgresql:\/\/)/.test(e.DATABASE_URL))
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL must start with sqlite: or postgres://' });
    if (e.AUDIT_DATABASE_URL && !/^(sqlite:|postgres:\/\/|postgresql:\/\/)/.test(e.AUDIT_DATABASE_URL))
      ctx.addIssue({ code: 'custom', path: ['AUDIT_DATABASE_URL'], message: 'AUDIT_DATABASE_URL must start with sqlite: or postgres://' });
  });

export type Env = z.infer<typeof Env>;
