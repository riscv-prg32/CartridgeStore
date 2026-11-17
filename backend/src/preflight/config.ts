import fs from "node:fs";
import path from "node:path";

export const PREFLIGHT_ABI = "prg32-operational-preflight-1.0" as const;

export type PreflightProfile = "candidate" | "operational";
export type PreflightStatus = "PASS" | "FAIL" | "NOT_VERIFIED";

export interface PreflightCheck {
  readonly id: string;
  readonly status: PreflightStatus;
  readonly detail: string;
}

export type SensitiveValueStatus = "PRESENT" | "MISSING" | "INVALID_REFERENCE";

export interface PreflightResult {
  readonly abi: typeof PREFLIGHT_ABI;
  readonly profile: PreflightProfile;
  readonly ok: boolean;
  readonly checks: readonly PreflightCheck[];
  readonly sensitive: Readonly<Record<string, SensitiveValueStatus>>;
}

export interface OidcPreflightContract {
  readonly providerId: string;
  readonly issuer: string;
  readonly discoveryEndpoint: string;
  readonly jwksUri: string;
  readonly clientId: string;
  readonly clientAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  readonly redirectUri: string;
  readonly logoutUri?: string;
  readonly scopes: readonly string[];
  readonly pkce: boolean;
  readonly state: boolean;
  readonly nonce: boolean;
}

export interface SamlPreflightContract {
  readonly providerId: string;
  readonly spEntityId: string;
  readonly acsUrl: string;
  readonly idpEntityId: string;
  readonly idpSsoUrl: string;
  readonly idpSigningCertificateReference: string;
  readonly wantAssertionsSigned: boolean;
  readonly wantAuthnResponseSigned: boolean;
  readonly allowedBinding: "HTTP-Redirect" | "HTTP-POST";
  readonly audience: string;
  readonly destination: string;
  readonly recipient: string;
  readonly replayProtection: boolean;
}

interface CheckBuilder {
  readonly checks: PreflightCheck[];
  add(id: string, status: PreflightStatus, detail: string): void;
}

function checker(): CheckBuilder {
  const checks: PreflightCheck[] = [];
  return {
    checks,
    add(id, status, detail) { checks.push({ id, status, detail }); }
  };
}

function value(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const candidate = environment[name]?.trim();
  return candidate || undefined;
}

function booleanValue(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean | undefined {
  const candidate = value(environment, name);
  if (candidate === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(candidate.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(candidate.toLowerCase())) return false;
  return undefined;
}

function origin(valueToCheck: string | undefined): URL | undefined {
  if (!valueToCheck) return undefined;
  try {
    const parsed = new URL(valueToCheck);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function endpoint(valueToCheck: string | undefined): URL | undefined {
  if (!valueToCheck) return undefined;
  try {
    const parsed = new URL(valueToCheck);
    if (parsed.username || parsed.password || parsed.hash) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function originEquals(left: string | undefined, right: string | undefined): boolean {
  const leftUrl = origin(left);
  const rightUrl = origin(right);
  return leftUrl !== undefined && rightUrl !== undefined && leftUrl.origin === rightUrl.origin;
}

function httpsOrigin(valueToCheck: string | undefined): boolean {
  const parsed = origin(valueToCheck);
  return parsed?.protocol === "https:";
}

function pathEquals(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && path.resolve(left) === path.resolve(right);
}

function statusForSecret(environment: NodeJS.ProcessEnv, name: string, minimumLength = 32): SensitiveValueStatus {
  const candidate = value(environment, name);
  const fileReference = value(environment, `${name}_FILE`);
  if (candidate && fileReference) return "INVALID_REFERENCE";
  if (candidate) return candidate.length >= minimumLength ? "PRESENT" : "INVALID_REFERENCE";
  if (!fileReference) return "MISSING";
  if (!path.isAbsolute(fileReference)) return "INVALID_REFERENCE";
  try {
    const stats = fs.lstatSync(fileReference);
    if (stats.isSymbolicLink() || !stats.isFile()) return "INVALID_REFERENCE";
    return stats.size >= minimumLength ? "PRESENT" : "INVALID_REFERENCE";
  } catch {
    return "INVALID_REFERENCE";
  }
}

function secretStatuses(environment: NodeJS.ProcessEnv): Readonly<Record<string, SensitiveValueStatus>> {
  return {
    PRG32_BACKEND_SESSION_SECRET: statusForSecret(environment, "PRG32_BACKEND_SESSION_SECRET"),
    PRG32_BACKEND_BOOTSTRAP_TOKEN: statusForSecret(environment, "PRG32_BACKEND_BOOTSTRAP_TOKEN"),
    PRG32_PREFLIGHT_OIDC_CLIENT_SECRET_REFERENCE: statusForSecret(environment, "PRG32_PREFLIGHT_OIDC_CLIENT_SECRET_REFERENCE", 1),
    PRG32_PREFLIGHT_SAML_CERTIFICATE_REFERENCE: statusForSecret(environment, "PRG32_PREFLIGHT_SAML_CERTIFICATE_REFERENCE", 1),
    PRG32_PREFLIGHT_BACKUP_KEY_REFERENCE: statusForSecret(environment, "PRG32_PREFLIGHT_BACKUP_KEY_REFERENCE", 1)
  };
}

function checkHttpsOrigins(builder: CheckBuilder, environment: NodeJS.ProcessEnv, profile: PreflightProfile): void {
  const store = value(environment, profile === "operational" ? "PRG32_PREFLIGHT_STORE_ORIGIN" : "PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN");
  const api = value(environment, profile === "operational" ? "PRG32_PREFLIGHT_API_ORIGIN" : "PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN");
  const oidc = value(environment, profile === "operational" ? "PRG32_PREFLIGHT_OIDC_PUBLIC_ORIGIN" : "PRG32_BACKEND_OIDC_PUBLIC_ORIGIN");
  const values = [store, api, oidc];
  builder.add(
    "public_origins_https",
    values.every(httpsOrigin) ? "PASS" : "FAIL",
    values.every(httpsOrigin) ? "Configured public origins are absolute HTTPS origins without credentials or path components" : "All public origins must be absolute HTTPS origins without credentials, paths, queries or fragments"
  );
  builder.add(
    "public_origins_distinct",
    originEquals(store, api) ? "FAIL" : "PASS",
    originEquals(store, api) ? "Store and API origins must be distinct in the two-origin deployment" : "Store and API origins are distinct"
  );
  builder.add(
    "federation_origin_alignment",
    originEquals(api, oidc) ? "PASS" : "FAIL",
    originEquals(api, oidc) ? "Federation callbacks use the API public origin" : "OIDC/federation public origin must equal the API public origin"
  );
}

function checkCandidate(builder: CheckBuilder, environment: NodeJS.ProcessEnv): void {
  const canonicalRoot = value(environment, "PRG32_BACKEND_CANONICAL_STORAGE_ROOT");
  const database = value(environment, "PRG32_BACKEND_DB");
  const storeRoot = value(environment, "PRG32_BACKEND_STORE_DATA");
  const authDatabase = value(environment, "PRG32_BACKEND_AUTH_WRITE_DB");
  const authRoot = value(environment, "PRG32_BACKEND_AUTH_DISPOSABLE_ROOT");
  const candidateMode = value(environment, "PRG32_BACKEND_CANDIDATE_MODE");
  const authEnabled = booleanValue(environment, "PRG32_BACKEND_AUTH_WRITE_ENABLED", false);
  const backupEnabled = booleanValue(environment, "PRG32_BACKEND_BACKUP_ENABLED", false);
  const mdnsEnabled = booleanValue(environment, "PRG32_BACKEND_MDNS_ENABLED", false);

  builder.add("candidate_mode", candidateMode === "two-service-disposable" ? "PASS" : "FAIL", candidateMode === "two-service-disposable" ? "Disposable two-service mode is explicit" : "Candidate mode must be two-service-disposable");
  builder.add("candidate_not_production", value(environment, "NODE_ENV")?.toLowerCase() === "production" ? "FAIL" : "PASS", value(environment, "NODE_ENV")?.toLowerCase() === "production" ? "Candidate mode cannot run as production" : "Candidate mode is not production");
  builder.add("canonical_paths", pathEquals(database, canonicalRoot ? path.join(canonicalRoot, "store.sqlite") : undefined) && pathEquals(storeRoot, canonicalRoot) ? "PASS" : "FAIL", pathEquals(database, canonicalRoot ? path.join(canonicalRoot, "store.sqlite") : undefined) && pathEquals(storeRoot, canonicalRoot) ? "Database and store paths share one canonical root" : "Database must be <canonical-root>/store.sqlite and store data must equal the canonical root");
  builder.add("canonical_auth_writer", authEnabled === true && value(environment, "PRG32_BACKEND_AUTH_WRITE_MODE") === "test" && pathEquals(authDatabase, database) && pathEquals(authRoot, canonicalRoot) ? "PASS" : "FAIL", authEnabled === true && value(environment, "PRG32_BACKEND_AUTH_WRITE_MODE") === "test" && pathEquals(authDatabase, database) && pathEquals(authRoot, canonicalRoot) ? "The disposable writer uses the canonical SQLite root" : "The candidate must have exactly one disposable canonical auth writer");
  builder.add("legacy_fallbacks_disabled", ["PRG32_USERS", "PRG32_SCORE_DB", "PRG32_METRICS_DB", "PRG32_STORE_DATA", "PRG32_STORE_DB"].every((name) => value(environment, name) === undefined) ? "PASS" : "FAIL", ["PRG32_USERS", "PRG32_SCORE_DB", "PRG32_METRICS_DB", "PRG32_STORE_DATA", "PRG32_STORE_DB"].every((name) => value(environment, name) === undefined) ? "Legacy fallback variables are absent" : "Legacy fallback variables must be absent in candidate mode");
  builder.add("candidate_mDNS_disabled", mdnsEnabled === false ? "PASS" : "FAIL", mdnsEnabled === false ? "mDNS is disabled in the disposable candidate" : "mDNS must remain disabled in candidate mode");
  builder.add("candidate_backup_disabled", backupEnabled === false ? "PASS" : "FAIL", backupEnabled === false ? "Operational backup activation is disabled in the disposable candidate" : "Backup activation is not permitted in candidate mode");
  builder.add("candidate_session_secret", authEnabled !== true || statusForSecret(environment, "PRG32_BACKEND_SESSION_SECRET") === "PRESENT" ? "PASS" : "FAIL", authEnabled !== true || statusForSecret(environment, "PRG32_BACKEND_SESSION_SECRET") === "PRESENT" ? "Session secret is present without exposing its value" : "A session secret of at least 32 characters is required when the candidate writer is enabled");
  checkHttpsOrigins(builder, environment, "candidate");
}

function checkOperational(builder: CheckBuilder, environment: NodeJS.ProcessEnv): void {
  const writer = value(environment, "PRG32_PREFLIGHT_WRITER_OWNER");
  const canonicalRoot = value(environment, "PRG32_PREFLIGHT_CANONICAL_ROOT");
  const database = value(environment, "PRG32_PREFLIGHT_DATABASE_PATH");
  const sessionSecure = booleanValue(environment, "PRG32_PREFLIGHT_SESSION_SECURE", false);
  const sameSite = value(environment, "PRG32_PREFLIGHT_SESSION_SAMESITE")?.toLowerCase();
  const backupEnabled = booleanValue(environment, "PRG32_PREFLIGHT_BACKUP_ENABLED", false);

  builder.add("operational_profile_explicit", value(environment, "PRG32_PREFLIGHT_PROFILE") === "operational" ? "PASS" : "FAIL", value(environment, "PRG32_PREFLIGHT_PROFILE") === "operational" ? "Operational preflight profile is explicit" : "Operational validation requires PRG32_PREFLIGHT_PROFILE=operational");
  builder.add("operational_node_environment", value(environment, "NODE_ENV")?.toLowerCase() === "production" ? "PASS" : "FAIL", value(environment, "NODE_ENV")?.toLowerCase() === "production" ? "Production runtime is explicit" : "Operational profile requires NODE_ENV=production");
  builder.add("single_writer_owner", writer === "fastify" ? "PASS" : "FAIL", writer === "fastify" ? "Fastify is the declared sole canonical writer" : "Exactly one explicit writer owner of fastify is required");
  builder.add("operational_canonical_paths", Boolean(canonicalRoot) && pathEquals(database, canonicalRoot ? path.join(canonicalRoot, "store.sqlite") : undefined) ? "PASS" : "FAIL", Boolean(canonicalRoot) && pathEquals(database, canonicalRoot ? path.join(canonicalRoot, "store.sqlite") : undefined) ? "Database is rooted under the declared canonical storage root" : "Operational database must be <canonical-root>/store.sqlite");
  builder.add("secure_session_cookie", sessionSecure === true && (sameSite === "lax" || sameSite === "strict" || sameSite === "none") ? "PASS" : "FAIL", sessionSecure === true && (sameSite === "lax" || sameSite === "strict" || sameSite === "none") ? "Secure session cookie and valid SameSite policy are explicit" : "Operational sessions require Secure=true and a valid SameSite value");
  builder.add("backup_key_reference", backupEnabled !== true || statusForSecret(environment, "PRG32_PREFLIGHT_BACKUP_KEY_REFERENCE", 1) === "PRESENT" ? "PASS" : "FAIL", backupEnabled !== true || statusForSecret(environment, "PRG32_PREFLIGHT_BACKUP_KEY_REFERENCE", 1) === "PRESENT" ? "Backup key custody is represented by a non-secret reference" : "Enabled backup configuration requires an external key reference");
  if (sameSite === "none") builder.add("same_site_none_secure", sessionSecure === true ? "PASS" : "FAIL", sessionSecure === true ? "SameSite=None is paired with Secure" : "SameSite=None requires Secure=true");
  checkHttpsOrigins(builder, environment, "operational");
  builder.add("runtime_support_boundary", "PASS", "Fastify is the sole application runtime");
}

export function validatePreflightConfiguration(environment: NodeJS.ProcessEnv, profile: PreflightProfile): PreflightResult {
  const builder = checker();
  if (profile === "candidate") checkCandidate(builder, environment);
  else checkOperational(builder, environment);
  const sensitive = secretStatuses(environment);
  return {
    abi: PREFLIGHT_ABI,
    profile,
    ok: builder.checks.every((check) => check.status === "PASS"),
    checks: builder.checks,
    sensitive
  };
}

export function validateOidcContract(contract: OidcPreflightContract, apiOrigin: string): readonly PreflightCheck[] {
  const builder = checker();
  const issuer = origin(contract.issuer);
  const discovery = endpoint(contract.discoveryEndpoint);
  const jwks = endpoint(contract.jwksUri);
  const api = origin(apiOrigin);
  const callback = endpoint(contract.redirectUri);
  const callbackBound = api !== undefined && callback?.origin === api.origin && callback.pathname === `/api/auth/oidc/${contract.providerId}/callback`;
  const securityParameters = contract.scopes.includes("openid") && contract.pkce && contract.state && contract.nonce;
  builder.add("oidc_https_issuer", issuer?.protocol === "https:" ? "PASS" : "FAIL", issuer?.protocol === "https:" ? "OIDC issuer uses HTTPS" : "OIDC issuer must use HTTPS");
  builder.add("oidc_discovery_bound", issuer !== undefined && discovery?.origin === issuer.origin ? "PASS" : "FAIL", issuer !== undefined && discovery?.origin === issuer.origin ? "Discovery is bound to the issuer origin" : "Discovery must remain on the issuer origin");
  builder.add("oidc_jwks_bound", issuer !== undefined && jwks?.origin === issuer.origin ? "PASS" : "FAIL", issuer !== undefined && jwks?.origin === issuer.origin ? "JWKS is bound to the issuer origin" : "JWKS must remain on the issuer origin");
  builder.add("oidc_callback_bound", callbackBound ? "PASS" : "FAIL", callbackBound ? "OIDC callback uses the API origin and provider path" : "OIDC callback must use the configured API origin and provider path");
  builder.add("oidc_security_parameters", securityParameters ? "PASS" : "FAIL", securityParameters ? "OIDC uses openid, PKCE, state and nonce" : "OIDC requires openid, PKCE, state and nonce");
  builder.add("oidc_client_auth_reference", contract.clientId.length > 0 && (contract.clientAuthMethod === "none" || contract.clientAuthMethod === "client_secret_basic" || contract.clientAuthMethod === "client_secret_post") ? "PASS" : "FAIL", contract.clientId.length > 0 ? "OIDC client identifier and authentication method are structurally valid" : "OIDC client identifier is required");
  return builder.checks;
}

export function validateSamlContract(contract: SamlPreflightContract, apiOrigin: string): readonly PreflightCheck[] {
  const builder = checker();
  const api = origin(apiOrigin);
  const acs = endpoint(contract.acsUrl);
  const idpSso = endpoint(contract.idpSsoUrl);
  const samlHttps = idpSso?.protocol === "https:" && acs?.protocol === "https:";
  const samlAcsBound = api !== undefined && acs?.origin === api.origin && acs.pathname === `/api/auth/saml/${contract.providerId}/acs`;
  const samlIdentity = contract.spEntityId.length > 0 && contract.idpEntityId.length > 0 && contract.audience.length > 0 && contract.idpSigningCertificateReference.length > 0;
  builder.add("saml_https_endpoints", samlHttps ? "PASS" : "FAIL", samlHttps ? "SAML SSO and ACS use HTTPS" : "SAML SSO and ACS must use HTTPS");
  builder.add("saml_acs_bound", samlAcsBound ? "PASS" : "FAIL", samlAcsBound ? "SAML ACS uses the API origin and provider path" : "SAML ACS must use the configured API origin and provider path");
  builder.add("saml_identity_contract", samlIdentity ? "PASS" : "FAIL", samlIdentity ? "SAML entities, audience and certificate reference are present" : "SAML entity IDs, audience and certificate reference are required");
  builder.add("saml_signature_policy", contract.wantAssertionsSigned && contract.wantAuthnResponseSigned ? "PASS" : "FAIL", contract.wantAssertionsSigned && contract.wantAuthnResponseSigned ? "SAML response and assertions must be signed" : "SAML response and assertion signatures are required");
  builder.add("saml_replay_protection", contract.replayProtection ? "PASS" : "FAIL", contract.replayProtection ? "SAML replay protection is explicit" : "SAML replay protection is required");
  builder.add("saml_binding", contract.allowedBinding === "HTTP-POST" || contract.allowedBinding === "HTTP-Redirect" ? "PASS" : "FAIL", "SAML binding is explicitly constrained");
  return builder.checks;
}
