import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Env, parseMasterKeys } from './env.js';
import { dialectOf, type Dialect } from '../db/url.js';

export interface Config {
  env: Env;
  publicUrl: string;
  /** Canonical MCP resource URI (RFC 8707 audience). */
  resourceUri: string;
  instanceId: string;
  dialect: Dialect;
  databaseUrl: string;
  auditDatabaseUrl: string;
  /** True when audit data lives in a separate database. */
  separateAuditDb: boolean;
  masterKeys: Map<string, Buffer>;
  activeKeyId: string;
  hashPepper: string;
  cookieNames: { session: string; consent: string };
  isProduction: boolean;
  serveWeb: boolean;
  webDistDir: string;
  /** Embedding model cache / local model directory (relative MODELS_DIR resolves against the server package). */
  modelsDir: string;
  /** Non-fatal configuration warnings to log at boot. */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** apps/server (works from src/ under tsx and dist/ when built). */
export const SERVER_PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Loads `.env` files outside production: `$NEUROUTER_ENV_FILE`, else the first of
 * `<cwd>/.env` and `<repo root>/.env`. Existing process env always wins.
 */
export function loadDotenv(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') return null;
  const candidates = env.NEUROUTER_ENV_FILE
    ? [env.NEUROUTER_ENV_FILE]
    : [resolve(process.cwd(), '.env'), resolve(SERVER_PACKAGE_DIR, '..', '..', '.env')];
  for (const file of candidates) {
    if (existsSync(file)) {
      loadEnvFile(file);
      return file;
    }
  }
  return null;
}

/** Parses and derives the runtime config. Throws ConfigError with every problem listed. */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
  }
  const env = parsed.data;
  const warnings: string[] = [];
  const isProduction = env.NODE_ENV === 'production';

  const publicUrl = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`;

  let masterKeys: Map<string, Buffer>;
  let activeKeyId: string;
  if (env.NEUROUTER_MASTER_KEYS) {
    masterKeys = parseMasterKeys(env.NEUROUTER_MASTER_KEYS);
    activeKeyId = env.NEUROUTER_ACTIVE_KEY_ID ?? [...masterKeys.keys()][0]!;
  } else {
    // dev/test only (production is rejected by the schema): ephemeral key, secrets won't survive a restart
    activeKeyId = 'dev-ephemeral';
    masterKeys = new Map([[activeKeyId, randomBytes(32)]]);
    if (env.NODE_ENV === 'development')
      warnings.push('NEUROUTER_MASTER_KEYS is not set: using an ephemeral key; stored secrets will not decrypt after a restart (run `npm run keys -- gen`)');
  }
  let hashPepper = env.HASH_PEPPER;
  if (!hashPepper) {
    hashPepper = randomBytes(32).toString('base64url');
    if (env.NODE_ENV === 'development') warnings.push('HASH_PEPPER is not set: using an ephemeral pepper; API keys will stop working after a restart');
  }

  const auditDatabaseUrl = env.AUDIT_DATABASE_URL ?? env.DATABASE_URL;
  const dialect = dialectOf(env.DATABASE_URL);
  if (isProduction && dialect === 'sqlite') warnings.push('SQLite is intended for local development; use Postgres in production');

  const secureCookies = publicUrl.startsWith('https://');
  const webDistDir = isAbsolute(env.WEB_DIST_DIR) ? env.WEB_DIST_DIR : resolve(SERVER_PACKAGE_DIR, env.WEB_DIST_DIR);

  return {
    env,
    publicUrl,
    resourceUri: `${publicUrl}/mcp`,
    instanceId: env.INSTANCE_ID ?? `${hostname()}-${randomBytes(3).toString('hex')}`,
    dialect,
    databaseUrl: env.DATABASE_URL,
    auditDatabaseUrl,
    separateAuditDb: auditDatabaseUrl !== env.DATABASE_URL,
    masterKeys,
    activeKeyId,
    hashPepper,
    // `__Host-` requires Secure; plain names on http://localhost (backend §7.1, R12)
    cookieNames: secureCookies
      ? { session: '__Host-nr_session', consent: '__Host-nr_consent' }
      : { session: 'nr_session', consent: 'nr_consent' },
    isProduction,
    serveWeb: env.SERVE_WEB ?? isProduction,
    webDistDir,
    modelsDir: isAbsolute(env.MODELS_DIR) ? env.MODELS_DIR : resolve(SERVER_PACKAGE_DIR, env.MODELS_DIR),
    warnings,
  };
}
