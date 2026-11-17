import crypto from "node:crypto";

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import * as oidc from "openid-client";
import type { Configuration, CustomFetchOptions } from "openid-client";
import type Database from "better-sqlite3";

import type { AdminAuditLog } from "../admin/audit.js";
import type { AuthService } from "../auth/service.js";
import type { BackendConfig } from "../config/env.js";
import { FederationIdentityError, type FederationIdentityService, ValidatedExternalIdentity } from "../federation/identity.js";
import { FederationProviderError, type FederationProviderService, type FederationProviderConfig } from "../federation/provider.js";
import { FederationTransactionError, type FederationTransactionStore } from "../federation/transaction.js";
import type { FederationLinkChallengeService } from "../federation/link-challenges.js";
import { SecretStorageError, type SecretStore } from "../secrets/service.js";
import { BoundedRateLimiter } from "../security/rate-limiter.js";
import { createCorrelation, parseCorrelation } from "./correlation.js";
import {
  assertOidcBoundEndpoint,
  oidcDigest,
  oidcUrlOrigin,
  OidcError,
  safeOidcReturnPath,
  safeOidcString,
} from "./validation.js";

const OIDC_CACHE_TTL_MS = 5 * 60 * 1000;
const OIDC_MAX_CACHE_ENTRIES = 16;
const OIDC_MAX_HTTP_BYTES = 1024 * 1024;
const OIDC_TIMEOUT_SECONDS = 5;
const OIDC_TRANSACTION_TTL_SECONDS = 300;
const OIDC_MAX_PENDING_TRANSACTIONS = 4096;
export { OidcError } from "./validation.js";

interface CacheEntry {
  readonly configuration: Configuration;
  readonly updatedAt: string;
  readonly expiresAt: number;
}

type UsableOidcProvider = Omit<FederationProviderConfig, "clientId" | "redirectUri"> & { readonly clientId: string; readonly redirectUri: string };

interface OidcRequestContext {
  readonly requestId: string;
  readonly ip: string;
}

export interface OidcLoginResult {
  readonly location: string;
  readonly correlationCookie: string;
}

export interface OidcCallbackResult {
  readonly userId: number;
  readonly returnPath: string;
  readonly sessionCookie: string;
  readonly correlationCookie: string;
}

export class OidcService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Configuration>>();
  private readonly loginLimiter: BoundedRateLimiter;
  private readonly callbackLimiter: BoundedRateLimiter;

  constructor(
    private readonly config: BackendConfig,
    private readonly database: Database.Database,
    private readonly auth: AuthService,
    private readonly providers: FederationProviderService,
    private readonly identities: FederationIdentityService,
    private readonly transactions: FederationTransactionStore,
    private readonly secrets: SecretStore,
    private readonly audit: AdminAuditLog,
    private readonly linkChallenges: FederationLinkChallengeService
  ) {
    this.loginLimiter = new BoundedRateLimiter(config.authRateLimitMax, config.authRateLimitWindowSeconds, Math.min(config.authRateLimitMaxClients, OIDC_MAX_PENDING_TRANSACTIONS));
    this.callbackLimiter = new BoundedRateLimiter(config.authRateLimitMax * 2, config.authRateLimitWindowSeconds, Math.min(config.authRateLimitMaxClients, OIDC_MAX_PENDING_TRANSACTIONS));
  }

  publicProviders(): readonly { provider_id: string; protocol: "oidc" | "saml"; display_name: string; enabled: boolean }[] {
    return this.providers.publicList();
  }

  async start(providerId: string, returnTo: string | null, context: OidcRequestContext): Promise<OidcLoginResult> {
    if (!this.loginLimiter.allow(context.ip + ":" + providerId)) throw new OidcError("oidc_rate_limited", 429, "too many OIDC requests");
    const provider = this.requireProvider(providerId);
    const returnPath = safeOidcReturnPath(returnTo);
    const configuration = await this.discover(provider);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const pkceVerifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(pkceVerifier);
    const browserBinding = crypto.randomBytes(32).toString("base64url");
    const callbackBinding = oidcDigest(provider.redirectUri + "\u0000" + browserBinding);
    const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: provider.redirectUri,
      response_type: "code",
      scope: provider.scopes.join(" "),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });
    const transaction = this.transactions.create({
      protocol: "oidc",
      providerId: provider.providerId,
      callbackBinding,
      state,
      nonce,
      pkceVerifier,
      requestId: context.requestId,
      returnPath,
      ttlSeconds: OIDC_TRANSACTION_TTL_SECONDS
    });
    this.auditEvent("federation.oidc.started", provider.providerId, context.requestId, "committed");
    return { location: authorizationUrl.toString(), correlationCookie: createCorrelation(this.config.authSessionSecret ?? "", transaction.transactionId, browserBinding) };
  }

  async complete(providerId: string, requestUrl: string, correlationCookie: string | undefined, sessionCookie: string | undefined, context: OidcRequestContext): Promise<OidcCallbackResult> {
    if (!this.callbackLimiter.allow(context.ip + ":" + providerId)) throw new OidcError("oidc_rate_limited", 429, "too many OIDC requests");
    const provider = this.requireProvider(providerId);
    const parsed = new URL(requestUrl, provider.redirectUri);
    const correlation = this.parseCorrelation(correlationCookie);
    if (!correlation) throw new OidcError("oidc_browser_binding_failed", 401, "OIDC browser correlation failed");
    const callbackBinding = oidcDigest(provider.redirectUri + "\u0000" + correlation.binding);
    if (correlation.transactionId.length < 43) throw new OidcError("oidc_transaction_invalid", 400, "OIDC transaction is invalid");
    const state = safeOidcString(parsed.searchParams.get("state"), 256);
    if (!state) throw new OidcError("oidc_state_invalid", 400, "OIDC state is invalid");
    let transaction;
    try {
      transaction = this.transactions.consume({ transactionId: correlation.transactionId, protocol: "oidc", providerId: provider.providerId, callbackBinding, state });
    } catch (error) {
      throw this.mapTransactionError(error);
    }
    const providerError = safeOidcString(parsed.searchParams.get("error"), 128);
    const authorizationCode = safeOidcString(parsed.searchParams.get("code"), 4096);
    if (providerError) {
      this.auditEvent("federation.oidc.rejected", provider.providerId, context.requestId, "rejected");
      throw new OidcError("oidc_provider_error", 401, "OIDC authentication was not completed");
    }
    if (!authorizationCode) throw new OidcError("oidc_code_missing", 400, "OIDC authorization response is invalid");
    let enabledProvider: FederationProviderConfig;
    try { enabledProvider = this.providers.enabled(provider.providerId, "oidc"); }
    catch (error) {
      if (error instanceof FederationProviderError) throw new OidcError(error.code, error.statusCode, error.message);
      throw error;
    }
    const configuration = await this.discover(enabledProvider);
    const checks: oidc.AuthorizationCodeGrantChecks = { expectedState: state, idTokenExpected: true };
    if (transaction.nonce !== null) checks.expectedNonce = transaction.nonce;
    if (transaction.pkceVerifier !== null) checks.pkceCodeVerifier = transaction.pkceVerifier;
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(configuration, parsed, checks);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code.includes("JWT") || code.includes("OAUTH_INVALID") || code.includes("RESPONSE") || code.includes("KEY_SELECTION")) {
        this.auditEvent("federation.oidc.rejected", enabledProvider.providerId, context.requestId, "rejected");
        throw new OidcError("oidc_callback_invalid", 401, "OIDC authentication response is invalid");
      }
      this.auditEvent("federation.oidc.provider_unavailable", enabledProvider.providerId, context.requestId, "failed");
      throw new OidcError("oidc_provider_unavailable", 503, "OIDC provider is unavailable");
    }
    const claims = await this.verifyIdToken(configuration, { ...enabledProvider, clientId: enabledProvider.clientId as string, redirectUri: enabledProvider.redirectUri as string }, tokens.id_token ?? null, context.requestId);
    if (!claims || typeof claims.iss !== "string" || claims.iss !== enabledProvider.issuer || typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 512) {
      throw new OidcError("oidc_identity_invalid", 401, "OIDC identity is invalid");
    }
    const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud.filter((value): value is string => typeof value === "string") : [];
    if (!audiences.includes(enabledProvider.clientId ?? "") || (audiences.length > 1 && claims.azp !== enabledProvider.clientId) || (claims.azp !== undefined && claims.azp !== enabledProvider.clientId)) {
      throw new OidcError("oidc_identity_invalid", 401, "OIDC identity is invalid");
    }
    const externalIdentity = ValidatedExternalIdentity.fromProtocolAdapter({
      protocol: "oidc",
      providerId: enabledProvider.providerId,
      issuer: claims.iss,
      subject: claims.sub,
      ...(typeof claims.email === "string" && claims.email.length <= 254 ? { email: claims.email } : {}),
      ...(typeof claims.preferred_username === "string" && claims.preferred_username.length <= 80 ? { username: claims.preferred_username } : {}),
      ...(typeof claims.name === "string" && claims.name.length <= 160 ? { displayName: claims.name } : {}),
      authenticatedAt: new Date().toISOString()
    });
    let resolved;
    try { resolved = this.identities.resolve(externalIdentity); }
    catch (error) {
      if (error instanceof FederationIdentityError && error.code === "federation_identity_unknown") {
        const linkChallenge = this.linkChallenges.stage(externalIdentity);
        throw new OidcError("oidc_identity_link_required", 401, "OIDC identity is not linked", { link_challenge: linkChallenge });
      }
      if (error instanceof FederationIdentityError && error.code === "federation_identity_email_required") throw new OidcError("oidc_identity_email_required", 401, "OIDC identity did not provide a usable email");
      if (error instanceof FederationIdentityError && error.code === "federation_identity_conflict") throw new OidcError("oidc_identity_conflict", 409, "OIDC identity requires an explicit account link");
      if (error instanceof FederationIdentityError && error.code === "federation_account_disabled") throw new OidcError("oidc_account_disabled", 403, "OIDC authentication is unavailable");
      throw error;
    }
    const current = this.auth.context(sessionCookie, undefined);
    const session = this.auth.rotateSession(current.session, resolved.userId);
    if (!session) throw new OidcError("oidc_session_unavailable", 503, "authentication session is unavailable");
    this.auditEvent("federation.oidc.succeeded", enabledProvider.providerId, context.requestId, "committed", oidcDigest(enabledProvider.issuer + "\u0000" + claims.sub).slice(0, 32));
    return { userId: resolved.userId, returnPath: transaction.returnPath, sessionCookie: session.cookieValue, correlationCookie: "" };
  }

  private requireProvider(providerId: string): UsableOidcProvider {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(providerId)) {
      throw new OidcError("oidc_provider_invalid", 400, "OIDC provider is invalid");
    }
    let provider: FederationProviderConfig;
    try { provider = this.providers.enabled(providerId, "oidc"); }
    catch (error) {
      if (error instanceof FederationProviderError) throw new OidcError(error.code, error.statusCode, error.message);
      throw error;
    }
    const clientId = provider.clientId;
    const redirectUri = provider.redirectUri;
    if (!clientId || !redirectUri || !provider.scopes.includes("openid")) throw new OidcError("oidc_provider_incomplete", 503, "OIDC provider configuration is incomplete");
    if (!this.config.oidcPublicOrigin) throw new OidcError("oidc_public_origin_missing", 503, "OIDC public origin is not configured");
    if (provider.clientAuthMethod === "none" && provider.clientSecretReference !== null) throw new OidcError("oidc_provider_invalid", 503, "OIDC provider configuration is invalid");
    if (provider.clientAuthMethod !== "none" && provider.clientSecretReference === null) throw new OidcError("oidc_client_secret_missing", 503, "OIDC provider client authentication is unavailable");
    const redirect = oidcUrlOrigin(redirectUri);
    if (this.config.oidcPublicOrigin && redirect.origin !== new URL(this.config.oidcPublicOrigin).origin) throw new OidcError("oidc_redirect_invalid", 503, "OIDC redirect configuration is invalid");
    const expectedPath = "/api/auth/oidc/" + provider.providerId + "/callback";
    if (redirect.pathname !== expectedPath || redirect.search || redirect.hash) throw new OidcError("oidc_redirect_invalid", 503, "OIDC redirect configuration is invalid");
    return { ...provider, clientId, redirectUri };
  }

  private async discover(provider: FederationProviderConfig): Promise<Configuration> {
    const now = Date.now();
    const cached = this.cache.get(provider.providerId);
    if (cached && cached.updatedAt === provider.updatedAt && cached.expiresAt > now) return cached.configuration;
    const existing = this.inFlight.get(provider.providerId);
    if (existing) return existing;
    const promise = this.discoverUncached(provider);
    this.inFlight.set(provider.providerId, promise);
    try {
      const configuration = await promise;
      if (this.cache.size >= OIDC_MAX_CACHE_ENTRIES && !this.cache.has(provider.providerId)) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(provider.providerId, { configuration, updatedAt: provider.updatedAt, expiresAt: Date.now() + OIDC_CACHE_TTL_MS });
      return configuration;
    } finally { this.inFlight.delete(provider.providerId); }
  }

  private async discoverUncached(provider: FederationProviderConfig): Promise<Configuration> {
    const discoveryIssuer = oidcUrlOrigin(provider.discoveryIssuer ?? provider.issuer);
    const allowHttp = this.config.authWriteMode === "test";
    const secret = provider.clientAuthMethod === "none" ? undefined : this.loadClientSecret(provider);
    const authentication = provider.clientAuthMethod === "client_secret_post"
      ? oidc.ClientSecretPost(secret)
      : provider.clientAuthMethod === "client_secret_basic" ? oidc.ClientSecretBasic(secret) : oidc.None();
    try {
      const configuration = await oidc.discovery(discoveryIssuer, provider.clientId ?? "", {
        redirect_uris: [provider.redirectUri ?? ""],
        response_types: ["code"],
        token_endpoint_auth_method: provider.clientAuthMethod,
        id_token_signed_response_alg: "RS256",
        ...(secret === undefined ? {} : { client_secret: secret })
      }, authentication, {
        timeout: OIDC_TIMEOUT_SECONDS,
        [oidc.customFetch]: this.createFetch(discoveryIssuer, allowHttp),
        ...(allowHttp ? { execute: [oidc.allowInsecureRequests] } : {})
      });
      const metadata = configuration.serverMetadata();
      if (metadata.issuer !== provider.issuer) throw new OidcError("oidc_metadata_issuer_mismatch", 503, "OIDC provider metadata is invalid");
      assertOidcBoundEndpoint(metadata.authorization_endpoint, discoveryIssuer, allowHttp);
      assertOidcBoundEndpoint(metadata.token_endpoint, discoveryIssuer, allowHttp);
      assertOidcBoundEndpoint(metadata.jwks_uri, discoveryIssuer, allowHttp);
      return configuration;
    } catch (error) {
      if (error instanceof OidcError) throw error;
      throw new OidcError("oidc_provider_unavailable", 503, "OIDC provider is unavailable");
    }
  }

  private createFetch(issuer: URL, allowHttp: boolean): (url: string, options: CustomFetchOptions) => Promise<Response> {
    return async (url, options) => {
      let endpoint: URL;
      try { endpoint = new URL(url); } catch { throw new Error("invalid OIDC endpoint"); }
      if (endpoint.origin !== issuer.origin || (endpoint.protocol !== "https:" && (!allowHttp || endpoint.protocol !== "http:")) || endpoint.username || endpoint.password || endpoint.hash) throw new Error("OIDC endpoint is outside the configured issuer origin");
      const contentLength = Number(options.headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > OIDC_MAX_HTTP_BYTES) throw new Error("OIDC request is too large");
      const response = await fetch(endpoint, { ...options, redirect: "manual" } as RequestInit);
      if (response.status >= 300 && response.status < 400) throw new Error("OIDC redirect is not allowed");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > OIDC_MAX_HTTP_BYTES) throw new Error("OIDC response is too large");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > OIDC_MAX_HTTP_BYTES) throw new Error("OIDC response is too large");
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }

  private loadClientSecret(provider: FederationProviderConfig): string {
    const reference = provider.clientSecretReference;
    if (!reference) throw new OidcError("oidc_client_secret_missing", 503, "OIDC provider client authentication is unavailable");
    const prefix = "federated-provider:" + provider.providerId + ":";
    if (!reference.startsWith(prefix)) throw new OidcError("oidc_provider_invalid", 503, "OIDC provider secret reference is invalid");
    const purpose = reference.slice(prefix.length);
    if (purpose !== "oidc-client-secret") throw new OidcError("oidc_provider_invalid", 503, "OIDC provider secret reference is invalid");
    try { return this.secrets.decryptProviderSecret(this.database, provider.providerId, "oidc-client-secret"); }
    catch (error) {
      if (error instanceof SecretStorageError) throw new OidcError("oidc_client_secret_unavailable", 503, "OIDC provider client authentication is unavailable");
      throw error;
    }
  }

  private async verifyIdToken(configuration: Configuration, provider: UsableOidcProvider, idToken: string | null, requestId: string): Promise<JWTPayload> {
    if (!idToken) throw new OidcError("oidc_identity_invalid", 401, "OIDC identity is invalid");
    const metadata = configuration.serverMetadata();
    const issuer = oidcUrlOrigin(provider.discoveryIssuer ?? provider.issuer);
    const jwksUri = assertOidcBoundEndpoint(metadata.jwks_uri, issuer, this.config.authWriteMode === "test");
    try {
      const response = await this.createFetch(issuer, this.config.authWriteMode === "test")(jwksUri, { method: "GET", headers: {} } as CustomFetchOptions);
      if (!response.ok) throw new Error("OIDC JWKS request failed");
      const jwks = await response.json() as JSONWebKeySet;
      const verified = await jwtVerify(idToken, createLocalJWKSet(jwks), {
        issuer: provider.issuer,
        audience: provider.clientId,
        algorithms: ["RS256"]
      });
      return verified.payload;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      this.auditEvent("federation.oidc.rejected", provider.providerId, requestId, "rejected");
      if (code.includes("ERR_JWKS") || code.includes("ERR_JWS") || code.includes("ERR_JWT") || code.includes("OAUTH")) {
        throw new OidcError("oidc_callback_invalid", 401, "OIDC authentication response is invalid");
      }
      throw new OidcError("oidc_provider_unavailable", 503, "OIDC provider is unavailable");
    }
  }

  private parseCorrelation(value: string | undefined): { transactionId: string; binding: string } | null {
    const secret = this.config.authSessionSecret;
    return secret ? parseCorrelation(secret, value) : null;
  }

  private mapTransactionError(error: unknown): OidcError {
    if (error instanceof FederationTransactionError) {
      if (error.code === "federation_transaction_replayed") return new OidcError("oidc_replay_rejected", 409, "OIDC callback was already used");
      if (error.code === "federation_transaction_expired") return new OidcError("oidc_transaction_expired", 400, "OIDC transaction expired");
      return new OidcError("oidc_transaction_invalid", 400, "OIDC transaction is invalid");
    }
    return new OidcError("oidc_transaction_invalid", 400, "OIDC transaction is invalid");
  }

  private auditEvent(action: string, providerId: string, requestId: string, outcome: "attempted" | "committed" | "failed" | "rejected", targetId = providerId): void {
    try { this.audit.append({ actor_user_id: 0, target_type: "oidc_provider", target_id: targetId, action, outcome, request_id: requestId }); } catch { /* authentication result is not changed by audit availability */ }
  }
}
