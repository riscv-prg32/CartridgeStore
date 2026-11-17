import crypto from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { encodePythonJson } from "../compatibility/serialization.js";
import type { BackendConfig } from "../config/env.js";
import { parseCookies } from "../auth/session.js";
import type { AuthRequestContext, AuthService } from "../auth/service.js";
import { permissionGuard } from "../authorization/guards.js";
import { BoundedRateLimiter } from "../security/rate-limiter.js";
import type { AuthorizationService } from "../authorization/service.js";
import type { Permission } from "../authorization/permissions.js";
import type { AdminAuditLog } from "../admin/audit.js";
import { AuditUnavailableError } from "../admin/audit.js";
import { FederationIdentityError, ValidatedExternalIdentity, type FederationIdentityService } from "./identity.js";
import { FederationProviderError, type FederationProviderService, type ProviderInput } from "./provider.js";
import type { FederationProviderOperations } from "./operations.js";
import { safeFederationProvider } from "./admin-provider-view.js";
import {
  providerId,
  providerInput,
  protocol,
  text,
} from "./provider-route-input.js";
import { FederationLinkChallengeError, type FederationLinkChallengeService } from "./link-challenges.js";
import type { FederationSecretPurpose } from "../secrets/service.js";

const SESSION_COOKIE = "prg32_ts_session";
const SECRET_PURPOSES = new Set<FederationSecretPurpose>([
  "oidc-client-secret",
  "saml-sp-signing-private-key",
  "saml-sp-decryption-private-key"
]);

type JsonObject = Record<string, unknown>;
interface ProviderParams { readonly providerId: string }
interface IdentityParams { readonly identityId: string }

interface FederationAdminRouteOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly authorization: AuthorizationService;
  readonly providers: FederationProviderService;
  readonly identities: FederationIdentityService;
  readonly operations: FederationProviderOperations;
  readonly audit: AdminAuditLog;
  readonly linkChallenges: FederationLinkChallengeService;
}

function json(reply: FastifyReply, body: unknown, status = 200): FastifyReply {
  return reply.code(status).header("content-type", "application/json").send(Buffer.from(`${encodePythonJson(body)}\n`, "utf8"));
}

function body(request: FastifyRequest): JsonObject {
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new FederationProviderError("invalid_json_object", 400, "request body must be a JSON object");
  }
  return request.body as JsonObject;
}

function context(request: FastifyRequest, auth: AuthService): AuthRequestContext {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim() || undefined
    : undefined;
  return auth.context(parseCookies(request.headers.cookie).get(SESSION_COOKIE), bearer);
}

function csrf(request: FastifyRequest): string {
  const value = request.headers["x-csrftoken"] ?? request.headers["x-csrf-token"];
  return typeof value === "string" ? value.trim() : "";
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function stableFailure(reply: FastifyReply, status: 401 | 403, code: string, error: string): FastifyReply {
  return json(reply, { ok: false, error, code }, status);
}

function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  options: FederationAdminRouteOptions,
  permission: Permission,
  mutation: boolean,
  recentReauth: boolean
): AuthRequestContext | null {
  const current = context(request, options.auth);
  if (!current.principal.authenticated) {
    stableFailure(reply, 401, "auth_required", "login required");
    return null;
  }
  if (!permissionGuard(options.authorization, current.principal, permission)) {
    stableFailure(reply, 403, "permission_denied", "permission denied");
    return null;
  }
  if (mutation && current.bearerOnly) {
    stableFailure(reply, 403, "admin_browser_session_required", "browser session required");
    return null;
  }
  if (mutation && (!current.session || !csrf(request) || !constantTimeEqual(current.session.csrfToken, csrf(request)))) {
    stableFailure(reply, 403, "csrf_failed", "csrf token missing or invalid");
    return null;
  }
  if (mutation) {
    try { options.audit.ensureReady(); }
    catch (error) { operationError(reply, request, error); return null; }
  }
  if (recentReauth && (!current.session || current.session.reauthenticatedAt === null ||
      current.session.reauthenticatedAt < Date.now() - options.config.authRecentReauthSeconds * 1000)) {
    stableFailure(reply, 403, "recent_reauthentication_required", "recent local administrator reauthentication required");
    return null;
  }
  return current;
}

function assertFields(value: JsonObject, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) {
    throw new FederationProviderError("unknown_field", 400, "request contains an unknown field");
  }
}

function identityId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new FederationIdentityError("invalid_identifier", 400, "identity_id is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new FederationIdentityError("invalid_identifier", 400, "identity_id is invalid");
  return parsed;
}

function userId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new FederationIdentityError("invalid_identifier", 400, "user_id is invalid");
  return Number(value);
}

function operationError(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
  request.log.warn({ err: error, requestId: request.id }, "federation administration request rejected");
  if (error instanceof FederationProviderError || error instanceof FederationIdentityError || error instanceof FederationLinkChallengeError) return json(reply, { ok: false, error: error.message, code: error.code }, error.statusCode ?? 400);
  if (error instanceof AuditUnavailableError) return json(reply, { ok: false, error: "administrative audit storage is unavailable", code: error.code }, error.statusCode);
  return json(reply, { ok: false, error: "federation administration operation failed", code: "federation_admin_failed" }, 500);
}

function mutationContext(current: AuthRequestContext, request: FastifyRequest) {
  if (current.principal.id === null) throw new FederationProviderError("auth_required", 401, "login required");
  return { actorUserId: current.principal.id, requestId: request.id };
}

export function registerFederationAdminRoutes(app: FastifyInstance, options: FederationAdminRouteOptions): void {
  const listPermission: Permission = "federation:read";
  const mutationPermission: Permission = "federation:manage";
  const reauthLimiter = new BoundedRateLimiter(
    options.config.authRateLimitMax,
    options.config.authRateLimitWindowSeconds,
    options.config.authRateLimitMaxClients
  );

  app.post("/api/admin/federation/reauthenticate", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, false);
    if (!current) return reply;
    try {
      const input = body(request);
      assertFields(input, ["password"]);
      const password = text(input.password, "password", 512, true) as string;
      if (!reauthLimiter.allow(`${current.principal.id}:${request.ip}`)) {
        return json(reply, { ok: false, error: "too many requests", code: "rate_limited" }, 429);
      }
      if (!options.auth.recentAdminReauthenticate(current.session as NonNullable<typeof current.session>, password)) {
        return json(reply, { ok: false, error: "local administrator reauthentication failed", code: "reauthentication_failed" }, 403);
      }
      options.audit.ensureReady();
      options.audit.append({ actor_user_id: current.principal.id as number, target_type: "admin_session", target_id: "reauthentication", action: "federation.admin.reauthenticated", outcome: "committed", request_id: request.id });
      return json(reply, { ok: true, expires_in_seconds: options.config.authRecentReauthSeconds });
    } catch (error) { return operationError(reply, request, error); }
  });

  app.get("/api/admin/federation/providers", async (request, reply) => {
    const current = requireAdmin(request, reply, options, listPermission, false, false);
    if (!current) return reply;
    try { return json(reply, { ok: true, providers: options.providers.list().map((provider) => safeFederationProvider(provider, options.operations)) }); }
    catch (error) { return operationError(reply, request, error); }
  });

  app.post("/api/admin/federation/providers", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, true);
    if (!current) return reply;
    try {
      const input = body(request);
      assertFields(input, ["provider_id", "protocol", "display_name", "issuer", "client_id", "client_auth_method", "client_secret", "discovery_issuer", "redirect_uri", "scopes", "idp_entity_id", "sp_entity_id", "acs_url", "saml_entry_point", "saml_name_id_format", "saml_idp_certificate_pem", "saml_trusted_certificates_pem", "saml_sp_certificate_pem", "saml_want_assertions_signed", "saml_want_authn_response_signed", "saml_sign_authn_requests", "saml_accepted_clock_skew_ms", "signing_key_reference"]);
      const inputConfig = providerInput(input);
      if (input.client_secret !== undefined && inputConfig.protocol !== "oidc") throw new FederationProviderError("federation_provider_invalid", 400, "client_secret is only valid for OIDC providers");
      if (input.client_secret !== undefined) options.operations.preflightProviderSecret(inputConfig.providerId, "oidc-client-secret", text(input.client_secret, "client_secret", 16384, true) as string);
      const configured = input.client_secret === undefined ? inputConfig : { ...inputConfig, clientSecretReference: `federated-provider:${inputConfig.providerId}:oidc-client-secret` };
      const created = options.providers.create(configured, mutationContext(current, request));
      if (input.client_secret !== undefined) options.operations.rotateProviderSecret(created.providerId, "oidc-client-secret", text(input.client_secret, "client_secret", 16384, true) as string, mutationContext(current, request));
      return json(reply, { ok: true, provider: safeFederationProvider(options.providers.get(created.providerId), options.operations) }, 201);
    } catch (error) { return operationError(reply, request, error); }
  });

  app.get<{ Params: ProviderParams }>("/api/admin/federation/providers/:providerId", async (request, reply) => {
    const current = requireAdmin(request, reply, options, listPermission, false, false);
    if (!current) return reply;
    try { return json(reply, { ok: true, provider: safeFederationProvider(options.providers.get(providerId(request.params.providerId)), options.operations) }); }
    catch (error) { return operationError(reply, request, error); }
  });

  app.patch<{ Params: ProviderParams }>("/api/admin/federation/providers/:providerId", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, true);
    if (!current) return reply;
    try {
      const input = body(request);
      assertFields(input, ["display_name", "client_id", "client_auth_method", "discovery_issuer", "redirect_uri", "scopes", "idp_entity_id", "sp_entity_id", "acs_url", "saml_entry_point", "saml_name_id_format", "saml_idp_certificate_pem", "saml_trusted_certificates_pem", "saml_sp_certificate_pem", "saml_want_assertions_signed", "saml_want_authn_response_signed", "saml_sign_authn_requests", "saml_accepted_clock_skew_ms", "signing_key_reference"]);
      const currentProvider = options.providers.get(providerId(request.params.providerId));
      const merged = providerInput({ provider_id: currentProvider.providerId, protocol: currentProvider.protocol, issuer: currentProvider.issuer, ...input });
      const changes = Object.fromEntries(Object.entries(merged).filter(([key]) => !["providerId", "protocol", "issuer"].includes(key))) as Partial<Omit<ProviderInput, "providerId" | "protocol" | "issuer">>;
      const updated = options.providers.update(currentProvider.providerId, changes, mutationContext(current, request));
      return json(reply, { ok: true, provider: safeFederationProvider(updated, options.operations) });
    } catch (error) { return operationError(reply, request, error); }
  });

  app.get<{ Params: ProviderParams }>("/api/admin/federation/providers/:providerId/status", async (request, reply) => {
    const current = requireAdmin(request, reply, options, listPermission, false, false);
    if (!current) return reply;
    try { return json(reply, { ok: true, provider: safeFederationProvider(options.providers.get(providerId(request.params.providerId)), options.operations) }); }
    catch (error) { return operationError(reply, request, error); }
  });

  app.post<{ Params: ProviderParams }>("/api/admin/federation/providers/:providerId/enable", async (request, reply) => changeEnabled(request, reply, options, true));
  app.post<{ Params: ProviderParams }>("/api/admin/federation/providers/:providerId/disable", async (request, reply) => changeEnabled(request, reply, options, false));

  app.post<{ Params: ProviderParams }>("/api/admin/federation/providers/:providerId/rotate-secret", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, true);
    if (!current) return reply;
    try {
      const input = body(request);
      assertFields(input, ["purpose", "secret"]);
      if (typeof input.purpose !== "string" || !SECRET_PURPOSES.has(input.purpose as FederationSecretPurpose)) throw new FederationProviderError("federation_provider_invalid", 400, "purpose is invalid");
      const secret = text(input.secret, "secret", 16384, true) as string;
      const targetProviderId = providerId(request.params.providerId);
      const purpose = input.purpose as FederationSecretPurpose;
      const status = options.operations.rotateProviderSecret(targetProviderId, purpose, secret, mutationContext(current, request));
      if (purpose === "oidc-client-secret") options.providers.update(targetProviderId, { clientSecretReference: `federated-provider:${targetProviderId}:oidc-client-secret` }, mutationContext(current, request));
      return json(reply, { ok: true, provider: status });
    } catch (error) { return operationError(reply, request, error); }
  });

  app.post<{ Params: ProviderParams }>("/api/admin/federation/providers/:providerId/certificates", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, true);
    if (!current) return reply;
    try {
      const input = body(request);
      assertFields(input, ["certificates"]);
      if (!Array.isArray(input.certificates) || input.certificates.length > 2 || input.certificates.some((item) => typeof item !== "string")) throw new FederationProviderError("federation_provider_invalid", 400, "certificates are invalid");
      const status = options.operations.updateTrustedSamlCertificates(providerId(request.params.providerId), input.certificates as string[], mutationContext(current, request));
      return json(reply, { ok: true, provider: status });
    } catch (error) { return operationError(reply, request, error); }
  });

  app.post<{ Params: ProviderParams }>("/api/admin/federation/providers/:providerId/transactions/revoke", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, true);
    if (!current) return reply;
    try { return json(reply, { ok: true, ...options.operations.revokePending(providerId(request.params.providerId), mutationContext(current, request)) }); }
    catch (error) { return operationError(reply, request, error); }
  });

  app.get("/api/admin/federation/identities", async (request, reply) => {
    const current = requireAdmin(request, reply, options, listPermission, false, false);
    if (!current) return reply;
    try { return json(reply, { ok: true, identities: options.identities.list({ includeRetired: true }) }); }
    catch (error) { return operationError(reply, request, error); }
  });

  app.get("/api/admin/federation/link-challenges", async (request, reply) => {
    const current = requireAdmin(request, reply, options, listPermission, false, false);
    if (!current) return reply;
    return json(reply, { ok: true, challenges: options.linkChallenges.list() });
  });

  app.post("/api/admin/federation/identities/from-challenge", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, true);
    if (!current) return reply;
    try {
      const input = body(request);
      assertFields(input, ["challenge_id", "user_id"]);
      const challengeId = text(input.challenge_id, "challenge_id", 128, true) as string;
      const identity = options.linkChallenges.get(challengeId);
      const linked = options.identities.link(identity, userId(input.user_id), {
        actorUserId: current.principal.id as number,
        actorRole: current.principal.role,
        reauthenticatedAt: current.session?.reauthenticatedAt ?? 0,
        requestId: request.id
      });
      options.linkChallenges.remove(challengeId);
      return json(reply, {
        ok: true,
        identity: {
          identityId: linked.identityId,
          userId: linked.userId,
          protocol: linked.protocol,
          providerId: linked.providerId,
          issuer: linked.issuer,
          lastLoginAt: linked.lastLoginAt
        }
      }, 201);
    } catch (error) { return operationError(reply, request, error); }
  });

  app.post("/api/admin/federation/identities", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, true);
    if (!current) return reply;
    try {
      const input = body(request);
      assertFields(input, ["protocol", "provider_id", "issuer", "subject", "user_id"]);
      const protocolValue = protocol(input.protocol);
      const providerValue = providerId(input.provider_id);
      const identity = ValidatedExternalIdentity.fromProtocolAdapter({ protocol: protocolValue, providerId: providerValue, issuer: text(input.issuer, "issuer", 512, true) as string, subject: text(input.subject, "subject", 512, true) as string, authenticatedAt: new Date().toISOString() });
      const linked = options.identities.link(identity, userId(input.user_id), { actorUserId: current.principal.id as number, actorRole: current.principal.role, reauthenticatedAt: current.session?.reauthenticatedAt ?? 0, requestId: request.id });
      return json(reply, { ok: true, identity: linked }, 201);
    } catch (error) { return operationError(reply, request, error); }
  });

  app.post<{ Params: IdentityParams }>("/api/admin/federation/identities/:identityId/retire", async (request, reply) => {
    const current = requireAdmin(request, reply, options, mutationPermission, true, true);
    if (!current) return reply;
    try {
      const id = identityId(request.params.identityId);
      const row = options.identities.list({ includeRetired: true }).find((item) => item.id === id);
      if (!row) throw new FederationIdentityError("federation_identity_unknown", 404, "federated identity is unknown");
      options.identities.unlink(id, { actorUserId: current.principal.id as number, actorRole: current.principal.role, reauthenticatedAt: current.session?.reauthenticatedAt ?? 0, requestId: request.id });
      return json(reply, { ok: true });
    } catch (error) { return operationError(reply, request, error); }
  });
}

async function changeEnabled(request: FastifyRequest<{ Params: ProviderParams }>, reply: FastifyReply, options: FederationAdminRouteOptions, enabled: boolean): Promise<FastifyReply> {
  const current = requireAdmin(request, reply, options, "federation:manage", true, true);
  if (!current) return reply;
  try { return json(reply, { ok: true, provider: options.operations.setEnabled(providerId(request.params.providerId), enabled, mutationContext(current, request)) }); }
  catch (error) { return operationError(reply, request, error); }
}
