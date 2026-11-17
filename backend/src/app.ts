import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import multipart from "@fastify/multipart";
import path from "node:path";
import type Database from "better-sqlite3";

import type { BackendConfig } from "./config/env.js";
import { ReadonlyDatabaseManager } from "./db/readonly.js";
import { CatalogError } from "./catalog/catalog.js";
import { registerCatalogRoutes } from "./catalog/routes.js";
import { encodePythonJson } from "./compatibility/serialization.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { AuthService } from "./auth/service.js";
import { publicSubmissionError, SubmissionError } from "./submission/errors.js";
import { registerSubmissionRoutes } from "./submission/routes.js";
import { SubmissionService } from "./submission/service.js";
import { registerReviewRoutes } from "./review/routes.js";
import { ReviewService } from "./review/service.js";
import { registerMetricsRoutes } from "./metrics/routes.js";
import { MetricsService } from "./metrics/service.js";
import { registerScoreRoutes, scoreRequestError } from "./scores/routes.js";
import { ScoresService } from "./scores/service.js";
import { registerStatsRoutes } from "./stats/routes.js";
import { registerProfileRoutes } from "./profile/routes.js";
import { BackupError } from "./backup/format.js";
import { registerBackupRoutes } from "./backup/routes.js";
import { BackupService } from "./backup/service.js";
import { AuthorizationService } from "./authorization/service.js";
import { registerSettingsRoutes } from "./settings/routes.js";
import { SettingsService } from "./settings/service.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { AdminIdentityService } from "./admin/service.js";
import { AdminTokenService } from "./admin/token-service.js";
import { CatalogAdminService } from "./admin/catalog-service.js";
import { PublicationConsistencyService } from "./consistency/publication.js";
import { SecretStore, SecretStorageError } from "./secrets/service.js";
import { registerOidcRoutes } from "./oidc/routes.js";
import { registerSamlRoutes } from "./saml/routes.js";
import { registerFederationLifecycleTestRoutes } from "./federation/lifecycle-test-routes.js";
import { registerFederationAdminRoutes } from "./federation/admin-routes.js";
import { createFederationRuntime } from "./federation/runtime.js";
import { ANONYMOUS, normalizeRole } from "./auth/principal.js";
import { lookupLegacyConfiguredUser } from "./auth/tokens.js";
import { MultiplayerHub } from "./multiplayer/hub.js";
import { registerMultiplayerRoutes } from "./multiplayer/routes.js";
import { openTargetStorage } from "./storage-v2/database.js";
import { CanonicalCatalog } from "./storage-v2/catalog.js";
import { CanonicalWorkflowService } from "./storage-v2/workflow.js";
import { CanonicalDraftService } from "./storage-v2/drafts.js";
import { mountDraftEndpoints } from "./storage-v2/draft-endpoints.js";
import { createDiscoveryService, DiscoveryDependencyError } from "./discovery/service.js";
import { createEmailService } from "./email/service.js";
import { createApprovalNotifier } from "./email/notifications.js";
import { AdminAuditLog } from "./admin/audit.js";
import { RuntimePolicy } from "./settings/runtime-policy.js";
import { registerSetupRoutes } from "./setup/routes.js";
import { SetupService } from "./setup/service.js";
import { WebAuthnService } from "./auth/webauthn.js";
import { registerWebAuthnRoutes } from "./auth/webauthn-routes.js";
import { BoundedRateLimiter } from "./security/rate-limiter.js";
import { rewriteVersionedApiUrl } from "./api/versioning.js";
import { FirmwareService } from "./firmware/service.js";
import { registerFirmwareRoutes } from "./firmware/routes.js";

export interface AppOptions {
  readonly config: BackendConfig;
  readonly logger?: FastifyServerOptions["logger"];
  readonly nowSeconds?: () => number;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const database = new ReadonlyDatabaseManager(options.config);
  const email = createEmailService(options.config);
  const approvalNotifier = createApprovalNotifier({
    email,
    ...(options.config.emailPublicOrigin === undefined ? {} : { publicOrigin: options.config.emailPublicOrigin }),
    storeName: options.config.storeName,
  });
  const auth = new AuthService({ config: options.config, readonlyDatabase: database, email });
  let runtimeDatabase: Database.Database | null = null;
  const runtimePolicy = new RuntimePolicy(() => runtimeDatabase ?? auth.database());
  auth.setRuntimePolicy(runtimePolicy);
  const canonicalWorkflow = options.config.canonicalWorkflowMode && options.config.canonicalStorageRoot
    ? new CanonicalWorkflowService({
      config: options.config,
      root: options.config.canonicalStorageRoot,
        database: openTargetStorage(options.config.canonicalStorageRoot, "read-write"),
        policy: runtimePolicy,
        approvalNotifier,
    })
    : null;
  const canonicalDrafts = canonicalWorkflow ? new CanonicalDraftService(canonicalWorkflow.database, canonicalWorkflow.paths, options.config, canonicalWorkflow) : null;
  const canonicalReadResource = canonicalWorkflow === null && options.config.canonicalStorageRoot
    ? openTargetStorage(options.config.canonicalStorageRoot, "read-only")
    : null;
  const canonicalDatabaseForReads = canonicalWorkflow?.database ?? canonicalReadResource?.sqlite;
  // Keep read-only configurations lazy: policy construction must not force a
  // database open merely to build the app or to report an unavailable target.
  runtimeDatabase = canonicalDatabaseForReads ?? null;
  const canonicalMode = canonicalWorkflow !== null || canonicalReadResource !== null;
  const multiplayerLimits = {
    maxConnections: options.config.multiplayerMaxConnections,
    maxConnectionsPerSource: options.config.multiplayerMaxConnectionsPerSource,
    maxConnectionsPerIdentity: options.config.multiplayerMaxConnectionsPerIdentity,
    maxUnjoinedConnections: options.config.multiplayerMaxUnjoinedConnections,
    messageRatePerSecond: options.config.multiplayerMessageRatePerSecond,
    messageBurst: options.config.multiplayerMessageBurst,
    stateRatePerSecond: options.config.multiplayerStateRatePerSecond,
    stateBurst: options.config.multiplayerStateBurst,
    joinRateMax: options.config.multiplayerJoinRateMax,
    joinRateWindowSeconds: options.config.multiplayerJoinRateWindowSeconds,
    sourceMessageRatePerSecond: options.config.multiplayerSourceMessageRatePerSecond,
    sourceMessageBurst: options.config.multiplayerSourceMessageBurst,
    identityMessageRatePerSecond: options.config.multiplayerIdentityMessageRatePerSecond,
    identityMessageBurst: options.config.multiplayerIdentityMessageBurst,
    maxMessageBytes: 64 * 1024,
    maxBufferedBytes: options.config.multiplayerMaxBufferedBytes
  } as const;
  const multiplayer = new MultiplayerHub({
    maxPeers: options.config.multiplayerMaxPeers,
    limits: multiplayerLimits,
    authenticationEnabled: options.config.legacyConfiguredUsers.length > 0 || auth.isWriteEnabled(),
    authenticate: (token) => {
      if (options.config.legacyConfiguredUsers.length > 0) {
        const user = lookupLegacyConfiguredUser(options.config.legacyConfiguredUsers, token);
        return user === null
          ? ANONYMOUS
          : {
            authenticated: true,
            id: null,
            name: user.name,
            username: user.name,
            email: "",
            role: normalizeRole(user.role),
            groups: [],
            authMethod: "legacy" as const
          };
      }
      return auth.context(undefined, token).principal;
    }
  });
  const authorization = new AuthorizationService();
  const secrets = new SecretStore({
    ...(options.config.secretKeyRegistryPath ? { keyRegistryPath: options.config.secretKeyRegistryPath } : {}),
    applicationDataRoot: options.config.canonicalStorageRoot ?? options.config.storeDataDirectory,
    maxRows: options.config.secretMaxRows
  });
  if (options.config.secretEncryptionEnabled || options.config.secretKeyRegistryPath) {
    const secretInventory = secrets.validateDatabase(auth.database());
    if (options.config.secretEncryptionEnabled && secretInventory.legacyPlaintext.length > 0) {
      throw new SecretStorageError("secret_plaintext_legacy", "secret settings require explicit migration before encryption is enabled");
    }
  }
  const auditDatabase = options.config.authWriteEnabled ? auth.writableDatabase() : undefined;
  const audit = new AdminAuditLog(options.config, auditDatabase);
  const identity = new AdminIdentityService({
    config: options.config,
    database: () => auth.database(),
    writableDatabase: options.config.authWriteEnabled ? auth.writableDatabase() : null,
    audit
  });
  const federation = createFederationRuntime({ config: options.config, auth, secrets, audit });
  const adminTokens = new AdminTokenService({
    config: options.config,
    database: () => auth.database(),
    writableDatabase: options.config.authWriteEnabled ? auth.writableDatabase() : null,
    audit
  });
  const discovery = createDiscoveryService(options.config);
  const settings = new SettingsService({
    config: options.config,
    database: () => canonicalDatabaseForReads ?? auth.database(),
    writableDatabase: options.config.authWriteEnabled ? auth.writableDatabase() : null,
    ...(options.config.canonicalStorageRoot ? { assetDirectory: path.join(options.config.canonicalStorageRoot, "storage", "objects", "site-assets") } : {}),
    secrets,
    audit,
    email,
    discovery
  });
  const setupDatabase = canonicalWorkflow?.database ?? (auth.isWriteEnabled() ? auth.writableDatabase() : null);
  const setup = new SetupService({
    config: options.config,
    auth,
    settings,
    providers: federation?.providers ?? null,
    operations: federation?.operations ?? null,
    audit,
    database: setupDatabase
  });
  const webauthn = options.config.webauthnEnabled
    ? new WebAuthnService(auth.writableDatabase(), auth, options.config, audit)
    : null;
  const backup = options.config.backupEnabled
    ? new BackupService(options.config, auth.writableDatabase(), { secrets })
    : null;
  backup?.recoverIncomplete();
  const submission = canonicalWorkflow ?? (options.config.submissionWriteEnabled
    ? new SubmissionService({ config: options.config, database: auth.writableDatabase(), policy: runtimePolicy })
    : null);
  const publication = canonicalWorkflow ? null : options.config.submissionWriteEnabled && options.config.submissionDisposableRoot
    ? new PublicationConsistencyService({ root: options.config.submissionDisposableRoot, database: auth.writableDatabase() })
    : null;
  const review = canonicalWorkflow ?? (options.config.submissionWriteEnabled && options.config.submissionDisposableRoot
    ? new ReviewService({
      root: options.config.submissionDisposableRoot,
      database: auth.writableDatabase(),
      maxSubmissions: options.config.reviewMaxSubmissions,
      policy: runtimePolicy,
      approvalNotifier,
      ...(publication === null ? {} : { publication })
    })
    : null);
  const canonicalAdminCatalog = options.config.canonicalStorageRoot
    ? new CanonicalCatalog(options.config.canonicalStorageRoot, {
      operational: options.config.catalogReadMode === "canonical-operational",
      legacyRoots: options.config.candidateRuntimeMode === undefined &&
        options.config.canonicalWorkflowMode === undefined &&
        options.config.catalogReadMode !== "canonical-operational"
        ? [options.config.storeDataDirectory, options.config.databasePath]
        : []
    })
    : null;
  const catalogAdmin = new CatalogAdminService({ config: options.config, publication, audit, moderationDatabase: canonicalWorkflow?.database ?? (options.config.authWriteEnabled ? auth.writableDatabase() : null), ...(canonicalAdminCatalog === null ? {} : { catalog: canonicalAdminCatalog }) });
  const metrics = new MetricsService({
    config: options.config,
    authorization,
    canonicalMode,
    policy: runtimePolicy,
    writeEnabled: canonicalWorkflow !== null || options.config.metricsWriteEnabled,
    database: canonicalDatabaseForReads ?? (options.config.metricsWriteEnabled
      ? auth.writableDatabase()
      : () => (auth.isWriteEnabled() ? auth.writableDatabase() : database.get().sqlite))
  });
  const scores = new ScoresService({
    config: options.config,
    writeEnabled: canonicalWorkflow !== null || options.config.scoresWriteEnabled,
    database: canonicalDatabaseForReads ?? (options.config.scoresWriteEnabled
      ? auth.writableDatabase()
      : () => (auth.isWriteEnabled() ? auth.writableDatabase() : database.get().sqlite))
  });
  const trustProxyPolicy = !options.config.trustProxy
    ? false
    : options.config.trustedProxyCidrs.length > 0
      ? [...options.config.trustedProxyCidrs]
      : (_address: string, hop: number) => hop < options.config.trustProxyHops;
  const app = Fastify({
    logger: options.logger ?? { level: options.config.logLevel },
    trustProxy: trustProxyPolicy,
    requestTimeout: options.config.httpRequestTimeoutMs,
    keepAliveTimeout: options.config.httpKeepAliveTimeoutMs,
    rewriteUrl: (request) => rewriteVersionedApiUrl(request.url)
  });
  const catalogRateLimiter = new BoundedRateLimiter(options.config.httpCatalogRateLimitMax, options.config.httpRateLimitWindowSeconds, options.config.httpRateLimitMaxClients);
  const downloadRateLimiter = new BoundedRateLimiter(options.config.httpDownloadRateLimitMax, options.config.httpRateLimitWindowSeconds, options.config.httpRateLimitMaxClients);
  const firmware = new FirmwareService(options.config);

  // Credentialed browser access is opt-in and exact-origin only. The default
  // empty allowlist preserves the existing same-origin behaviour.
  const corsOrigins = new Set(options.config.corsAllowedOrigins);
  if (corsOrigins.size > 0) {
    app.addHook("onRequest", async (request, reply) => {
      const origin = request.headers.origin;
      if (typeof origin !== "string" || origin.length === 0) return;
      // A SAML ACS submission is a browser form navigation from the external
      // identity provider, not a script-initiated CORS request. Its Origin is
      // therefore intentionally outside the API allowlist.
      if (request.method === "POST" && request.url.startsWith("/api/auth/saml/") && request.url.endsWith("/acs")) return;
      if (!corsOrigins.has(origin)) {
        return reply.code(403).header("content-type", "application/json").send(Buffer.from(`${encodePythonJson({ ok: false, error: "origin is not allowed", code: "cors_origin_denied" })}\n`, "utf8"));
      }
      reply
        .header("access-control-allow-origin", origin)
        .header("access-control-allow-credentials", "true")
        .header("access-control-allow-methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
        .header("access-control-allow-headers", "Accept,Content-Type,X-CSRFToken,X-CSRF-Token")
        .header("access-control-max-age", "300")
        .header("vary", "Origin");
      if (request.method === "OPTIONS") return reply.code(204).send();
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    const pathOnly = request.url.split("?", 1)[0] ?? "";
    const limiter = request.method === "GET" && pathOnly === "/api/games"
      ? catalogRateLimiter
      : request.method === "GET" && /^\/api\/games\/[^/]+\/download$/u.test(pathOnly)
        ? downloadRateLimiter
        : null;
    if (limiter === null) return;
    const key = request.ip || "unknown";
    if (limiter.allow(key)) return;
    return reply
      .code(429)
      .header("retry-after", String(options.config.httpRateLimitWindowSeconds))
      .header("content-type", "application/json")
      .send(Buffer.from(`${encodePythonJson({ ok: false, error: "too many requests", code: "rate_limited" })}\n`, "utf8"));
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: options.config.samlMaxPostBytes }, (_request, body, done) => {
    try { done(null, new URLSearchParams(String(body))); }
    catch { done(new Error("invalid form body")); }
  });

  const catalogRoutes = registerCatalogRoutes(app, {
    config: options.config,
    database,
    auth,
    ...(canonicalWorkflow === null ? {} : { downloadTelemetry: canonicalWorkflow })
  });
  registerFirmwareRoutes(app, firmware);
  registerAuthRoutes(app, { config: options.config, auth, authorization, email, legacyBootstrapAllowed: () => setup.legacyBootstrapAllowed() });
  registerWebAuthnRoutes(app, { config: options.config, auth, authorization, webauthn });
  registerSetupRoutes(app, { config: options.config, setup });
  if (federation) {
    registerOidcRoutes(app, { config: options.config, oidc: federation.oidc, sessionLifetimeSeconds: () => auth.sessionLifetimeSeconds() });
    registerSamlRoutes(app, { config: options.config, saml: federation.saml, sessionLifetimeSeconds: () => auth.sessionLifetimeSeconds() });
    registerFederationAdminRoutes(app, {
      config: options.config,
      auth,
      authorization,
      providers: federation.providers,
      identities: federation.identities,
      operations: federation.operations,
      audit: federation.audit,
      linkChallenges: federation.linkChallenges
    });
    if (options.config.federationLifecycleTestEnabled) {
      registerFederationLifecycleTestRoutes(app, { token: options.config.federationLifecycleTestToken, operations: federation.operations });
    }
  }
  app.register(multipart, {
    limits: {
      fileSize: Math.max(options.config.submissionMaxArchiveBytes, options.config.backupMaxArchiveBytes),
      files: 1,
      fields: 8,
      parts: 12
    }
  });
  const multiplayerPublicOrigin = options.config.federationPublicOrigin ?? options.config.frontendPublicOrigin;
  const multiplayerRouteOptions = {
    hub: multiplayer,
    limits: multiplayerLimits,
    heartbeatIntervalSeconds: options.config.multiplayerHeartbeatIntervalSeconds,
    heartbeatGraceSeconds: options.config.multiplayerHeartbeatGraceSeconds,
    unjoinedTimeoutSeconds: options.config.multiplayerUnjoinedTimeoutSeconds
  } as const;
  if (multiplayerPublicOrigin) registerMultiplayerRoutes(app, { ...multiplayerRouteOptions, publicOrigin: multiplayerPublicOrigin });
  else registerMultiplayerRoutes(app, multiplayerRouteOptions);
  registerSettingsRoutes(app, { config: options.config, auth, authorization, settings });
  registerAdminRoutes(app, { auth, authorization, identity, tokens: adminTokens, catalog: catalogAdmin });
  registerBackupRoutes(app, { config: options.config, auth, authorization, backup });
  registerSubmissionRoutes(app, { config: options.config, auth, authorization, submission });
  registerReviewRoutes(app, { config: options.config, auth, authorization, review });
  if (canonicalDrafts) mountDraftEndpoints(app, { config: options.config, auth, authorization, drafts: canonicalDrafts });
  registerMetricsRoutes(app, { config: options.config, auth, metrics });
  registerScoreRoutes(app, { config: options.config, auth, scores });
  registerStatsRoutes(app, {
    database: canonicalDatabaseForReads ?? database,
    catalog: catalogRoutes,
    canonicalMode,
    ...(options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds })
  });
  registerProfileRoutes(app, { database: canonicalDatabaseForReads ?? database, auth });

  app.addHook("onRequest", async (request) => {
    // Registration links carry a one-time secret in the query string. Keep
    // request diagnostics useful without copying that secret into logs.
    request.log.info({ method: request.method, url: request.url.split("?", 1)[0] }, "request received");
    await Promise.resolve();
  });

  app.addHook("onReady", async () => {
    let persistedPreference: boolean | undefined;
    try {
      persistedPreference = settings.mdnsPreference();
    } catch {
      // If the read model is unavailable, retain the explicit env-controlled
      // startup behavior so the failure is reported by the discovery layer.
      if (options.config.mdnsEnabled) persistedPreference = true;
    }
    if (persistedPreference !== undefined) {
      if (!persistedPreference) return;
      if (!options.config.mdnsEnabled) {
        app.log.warn("mDNS is enabled in application settings but disabled by deployment policy");
        return;
      }
    } else if (!options.config.mdnsEnabled) {
      return;
    } else {
      // The deployment enables the capability; the browser preference still
      // controls whether this instance advertises itself.
      return;
    }
    try {
      await discovery.setEnabled(true);
    } catch (error) {
      const code = error instanceof DiscoveryDependencyError ? error.code : "mdns_start_failed";
      app.log.error({ code }, "mDNS startup failed while explicitly enabled");
      throw error;
    }
  });

  app.get("/health", () => ({
    ok: true,
    service: "prg32-cartridge-store-backend",
    status: "healthy"
  }));

  app.get("/ready", async (_request, reply) => {
    let databaseReady = false;
    let storageReady = true;
    let writerReady = true;
    try {
      if (canonicalWorkflow) {
        canonicalWorkflow.database.prepare("SELECT 1").get();
        const state = canonicalWorkflow.database.prepare("SELECT state FROM storage_metadata WHERE singleton_id = 1").get() as { state?: string } | undefined;
        storageReady = state?.state === "ready";
        databaseReady = true;
      } else {
        databaseReady = database.check();
      }
    } catch {
      databaseReady = false;
      storageReady = false;
    }
    if (options.config.candidateRuntimeMode !== undefined || options.config.catalogReadMode === "canonical-operational") writerReady = canonicalWorkflow !== null;
    const ready = databaseReady && storageReady && writerReady;
    const resources = options.config.candidateRuntimeMode === undefined && options.config.catalogReadMode !== "canonical-operational"
      ? { database: ready ? "available" : "unavailable" }
      : {
          database: databaseReady ? "available" : "unavailable",
          canonical_storage: storageReady ? "available" : "unavailable",
          writer_lease: writerReady ? "held" : "unavailable"
        };
    const body = {
      ok: ready,
      status: ready ? "ready" : "not_ready",
      resources
    } as const;
    if (!ready) {
      return reply.code(503).send(body);
    }
    return body;
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, "request failed");
    const metricsRequest = request.url.startsWith("/api/metrics/batch") || request.url.startsWith("/api/runs");
    const scoreRequest = request.url.split("?", 1)[0] === "/api/scores" && request.method === "POST";
    const samlRequest = request.url.startsWith("/api/auth/saml/");
    if (error instanceof Error && (error as Error & { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE" && samlRequest) {
      return reply
        .code(413)
        .header("content-type", "application/json")
        .send(Buffer.from(`${encodePythonJson({ ok: false, error: "SAML response is too large", code: "saml_response_too_large" })}\n`, "utf8"));
    }
    if (error instanceof Error && (error as Error & { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE" && metricsRequest) {
      return reply
        .code(413)
        .header("content-type", "application/json")
        .send(Buffer.from(`${encodePythonJson({ ok: false, error: "metrics payload is too large", code: "metrics_payload_too_large" })}\n`, "utf8"));
    }
    if (error instanceof Error && (error as Error & { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY" && metricsRequest) {
      return reply
        .code(400)
        .header("content-type", "application/json")
        .send(Buffer.from(`${encodePythonJson({ ok: false, error: "invalid metrics JSON", code: "invalid_metrics_json" })}\n`, "utf8"));
    }
    if (scoreRequest) {
      const scoreError = scoreRequestError(error);
      if (scoreError) {
        return reply
          .code(scoreError.statusCode)
          .header("content-type", "application/json")
          .send(Buffer.from(`${encodePythonJson(scoreError.body)}\n`, "utf8"));
      }
    }
    if (error instanceof CatalogError) {
      return reply
        .code(400)
        .header("content-type", "application/json")
        .send(Buffer.from(`${encodePythonJson({ ok: false, error: "invalid request", code: "invalid_request" })}\n`, "utf8"));
    }
    if (error instanceof SubmissionError) {
      const publicError = publicSubmissionError(error);
      return reply
        .code(publicError.statusCode)
        .header("content-type", "application/json")
        .send(Buffer.from(`${encodePythonJson(publicError.body)}\n`, "utf8"));
    }
    if (error instanceof BackupError && request.url.startsWith("/admin/backup")) {
      return reply
        .code(error.statusCode)
        .header("content-type", "application/json")
        .send(Buffer.from(`${encodePythonJson({ ok: false, error: error.message, code: error.code })}\n`, "utf8"));
    }
    return reply
      .code(500)
      .header("content-type", "application/json")
      .send(Buffer.from(`${encodePythonJson({
        ok: false,
        error: "internal server error",
        code: "internal_error"
      })}\n`, "utf8"));
  });

  app.addHook("onClose", async () => {
    await discovery.stop();
    multiplayer.close();
    catalogRoutes.close();
    canonicalAdminCatalog?.close();
    canonicalWorkflow?.close();
    canonicalReadResource?.close();
    auth.close();
    email.close();
    database.close();
  });

  return app;
}
