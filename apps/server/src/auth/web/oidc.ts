import * as client from 'openid-client';

export interface OidcCallbackResult {
  claims: Record<string, unknown>;
  idToken: string | null;
}

/** Thin seam over openid-client v6 so login logic is unit-testable with a fake provider. */
export interface OidcProvider {
  readonly issuer: string;
  authorizationUrl(p: { redirectUri: string; scope: string; state: string; nonce: string; codeChallenge: string }): Promise<string>;
  /** Validates state/nonce/PKCE/iss and returns the merged ID-token + userinfo claims. */
  callback(currentUrl: URL, checks: { codeVerifier: string; state: string; nonce: string }): Promise<OidcCallbackResult>;
  endSessionUrl(p: { idTokenHint: string | null; postLogoutRedirectUri: string }): Promise<string | null>;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Allow http issuers (dev only). */
  allowInsecure?: boolean;
}

/** openid-client implementation. Discovery runs lazily and is cached; failures retry on the next call. */
export class OpenIdClientProvider implements OidcProvider {
  private config: Promise<client.Configuration> | null = null;

  constructor(private readonly cfg: OidcConfig) {}

  get issuer(): string {
    return this.cfg.issuer;
  }

  private configuration(): Promise<client.Configuration> {
    if (!this.config) {
      const opts = this.cfg.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined;
      this.config = client.discovery(new URL(this.cfg.issuer), this.cfg.clientId, this.cfg.clientSecret, undefined, opts).catch((err: unknown) => {
        this.config = null;
        throw err;
      });
    }
    return this.config;
  }

  /** Readiness probe: discovery succeeded. */
  async ready(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.configuration();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async authorizationUrl(p: { redirectUri: string; scope: string; state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const config = await this.configuration();
    return client
      .buildAuthorizationUrl(config, { redirect_uri: p.redirectUri, scope: p.scope, state: p.state, nonce: p.nonce, code_challenge: p.codeChallenge, code_challenge_method: 'S256' })
      .toString();
  }

  async callback(currentUrl: URL, checks: { codeVerifier: string; state: string; nonce: string }): Promise<OidcCallbackResult> {
    const config = await this.configuration();
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const claims: Record<string, unknown> = { ...(tokens.claims() ?? {}) };
    if (config.serverMetadata().userinfo_endpoint && typeof claims.sub === 'string') {
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
        for (const [k, v] of Object.entries(info)) if (!(k in claims)) claims[k] = v;
      } catch {
        // userinfo is optional; the ID token is authoritative
      }
    }
    return { claims, idToken: tokens.id_token ?? null };
  }

  /** RP-initiated logout URL when the IdP advertises `end_session_endpoint`. */
  async endSessionUrl(p: { idTokenHint: string | null; postLogoutRedirectUri: string }): Promise<string | null> {
    try {
      const config = await this.configuration();
      if (!config.serverMetadata().end_session_endpoint) return null;
      const params: Record<string, string> = { post_logout_redirect_uri: p.postLogoutRedirectUri };
      if (p.idTokenHint) params.id_token_hint = p.idTokenHint;
      return client.buildEndSessionUrl(config, params).toString();
    } catch {
      return null;
    }
  }
}
