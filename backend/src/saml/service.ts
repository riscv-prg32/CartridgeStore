import crypto from "node:crypto";

import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import type Database from "better-sqlite3";

import type { AdminAuditLog } from "../admin/audit.js";
import type { AuthService } from "../auth/service.js";
import type { BackendConfig } from "../config/env.js";
import { FederationIdentityError, type FederationIdentityService, ValidatedExternalIdentity } from "../federation/identity.js";
import { FederationProviderError, type FederationProviderConfig, type FederationProviderService } from "../federation/provider.js";
import { FederationTransactionError, type FederationTransactionStore } from "../federation/transaction.js";
import type { FederationLinkChallengeService } from "../federation/link-challenges.js";
import { SecretStorageError, type SecretStore } from "../secrets/service.js";
import { BoundedRateLimiter } from "../security/rate-limiter.js";
import { createSamlCorrelation, parseSamlCorrelation } from "./correlation.js";
import { signatureDiagnosticCode } from "./signature-diagnostics.js";
import {
  boundedSamlValue,
  SAML_PERSISTENT_NAME_ID,
  samlDigest,
  SamlError,
  safeSamlReturnPath,
  validateSamlCertificate,
} from "./validation.js";

const SAML_TRANSACTION_TTL_SECONDS = 300;
export { SamlError } from "./validation.js";

interface SamlRequestContext {
  readonly requestId: string;
  readonly ip: string;
}

export interface SamlLoginResult {
  readonly location: string;
  readonly correlationCookie: string;
}

export interface SamlCallbackResult {
  readonly userId: number;
  readonly returnPath: string;
  readonly sessionCookie: string;
}

interface PendingRow {
  readonly requestId: string;
  readonly transactionId: string;
  readonly callbackBinding: string;
  readonly expiresAt: number;
}

function withRequestId(pending: { readonly requestId: string | null; readonly transactionId: string; readonly callbackBinding: string; readonly expiresAt: number }): PendingRow {
  if (!pending.requestId) throw new SamlError("saml_transaction_invalid", 500, "SAML transaction is unavailable");
  return { requestId: pending.requestId, transactionId: pending.transactionId, callbackBinding: pending.callbackBinding, expiresAt: pending.expiresAt };
}

class SamlEnvelopeError extends Error {
  constructor(readonly category: "parse" | "root" | "id" | "destination") {
    super("SAML response envelope is invalid");
    this.name = "SamlEnvelopeError";
  }
}

function validationCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/multiple assertions/i.test(message)) return "multiple_assertions";
  if (/cannot obtain assertion/i.test(message)) return "assertion_signature";
  if (/invalid signature on documentelement/i.test(message)) return "document_element_signature";
  if (/invalid document signature/i.test(message)) return "document_signature";
  if (/signature|signed data/i.test(message)) return "signature";
  if (/audience/i.test(message)) return "audience";
  if (/inresponseto|subjectinresponseto|cache/i.test(message)) return "in_response_to";
  if (/destination/i.test(message)) return "destination";
  if (/recipient/i.test(message)) return "recipient";
  if (/issuer/i.test(message)) return "issuer";
  if (/notbefore|notonorafter|expired|clock|time/i.test(message)) return "time";
  if (/assertion|subject confirmation/i.test(message)) return "assertion";
  return "other";
}

function embeddedCertificateFingerprint(value: string): string | null {
  try {
    const xml = Buffer.from(value, "base64").toString("utf8");
    const match = /<[^>]*X509Certificate[^>]*>\s*([^<]+?)\s*<\//i.exec(xml);
    if (!match?.[1]) return null;
    const der = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
    return der.length === 0 ? null : crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

function profileAttribute(profile: Profile, names: readonly string[], max: number): string | null {
  const values = profile as unknown as Record<string, unknown>;
  for (const name of names) {
    const candidate = values[name];
    const value = Array.isArray(candidate) ? candidate.find((item): item is string => typeof item === "string") : candidate;
    const result = boundedSamlValue(typeof value === "string" ? value : null, max);
    if (result) return result;
  }
  return null;
}

function assertionId(profile: Profile): string {
  const assertion = profile.getAssertion?.();
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) throw new SamlError("saml_assertion_invalid", 401, "SAML assertion is invalid");
  const node = assertion.Assertion;
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new SamlError("saml_assertion_invalid", 401, "SAML assertion is invalid");
  const attributes = (node as Record<string, unknown>).$;
  const identifier = attributes && typeof attributes === "object" && !Array.isArray(attributes)
    ? (attributes as Record<string, unknown>).ID
    : undefined;
  if (typeof identifier !== "string" || identifier.length < 1 || identifier.length > 512) {
    throw new SamlError("saml_assertion_invalid", 401, "SAML assertion is invalid");
  }
  return identifier;
}

function responseEnvelope(value: string, acsUrl: string): { readonly responseId: string } {
  try {
    const xml = Buffer.from(value, "base64").toString("utf8");
    const document = new DOMParser({ errorHandler: () => undefined }).parseFromString(xml, "text/xml");
    const root = document.documentElement;
    const localName = root?.localName ?? root?.nodeName.split(":").pop();
    const responseId = root?.getAttribute("ID") ?? "";
    const destination = root?.getAttribute("Destination") ?? "";
    if (localName !== "Response") throw new SamlEnvelopeError("root");
    if (responseId.length < 1 || responseId.length > 512) throw new SamlEnvelopeError("id");
    if (destination !== acsUrl) throw new SamlEnvelopeError("destination");
    return { responseId };
  } catch (error) {
    if (error instanceof SamlEnvelopeError) throw error;
    throw new SamlEnvelopeError("parse");
  }
}

function verifiedRecipient(profile: Profile, acsUrl: string, requestId: string): void {
  const assertion = profile.getAssertion?.();
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) throw new SamlError("saml_assertion_invalid", 401, "SAML assertion is invalid");
  const node = assertion.Assertion;
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new SamlError("saml_assertion_invalid", 401, "SAML assertion is invalid");
  const subject = (node as Record<string, unknown>).Subject;
  const subjectRecord: unknown = Array.isArray(subject) ? subject[0] as unknown : undefined;
  const confirmations = subjectRecord && typeof subjectRecord === "object" && !Array.isArray(subjectRecord)
    ? (subjectRecord as Record<string, unknown>).SubjectConfirmation
    : undefined;
  const confirmation: unknown = Array.isArray(confirmations) ? confirmations[0] as unknown : undefined;
  const data = confirmation && typeof confirmation === "object" && !Array.isArray(confirmation)
    ? (confirmation as Record<string, unknown>).SubjectConfirmationData
    : undefined;
  const dataRecord: unknown = Array.isArray(data) ? data[0] as unknown : undefined;
  const attributes = dataRecord && typeof dataRecord === "object" && !Array.isArray(dataRecord)
    ? (dataRecord as Record<string, unknown>).$
    : undefined;
  const values = attributes && typeof attributes === "object" && !Array.isArray(attributes) ? attributes as Record<string, unknown> : null;
  if (!values || values.Recipient !== acsUrl || values.InResponseTo !== requestId) {
    throw new SamlError("saml_subject_confirmation_invalid", 401, "SAML subject confirmation is invalid");
  }
}

function samlProvider(provider: FederationProviderConfig, config: BackendConfig): FederationProviderConfig {
  if (provider.protocol !== "saml") throw new SamlError("saml_provider_protocol_mismatch", 409, "SAML provider protocol does not match");
  if (!config.federationPublicOrigin) throw new SamlError("saml_public_origin_missing", 503, "SAML public origin is not configured");
  if (!provider.idpEntityId || !provider.spEntityId || !provider.acsUrl || !provider.samlEntryPoint || !provider.samlNameIdFormat || !provider.samlIdpCertificatePem || provider.samlTrustedCertificatesPem.length < 1) {
    throw new SamlError("saml_provider_incomplete", 503, "SAML provider configuration is incomplete");
  }
  let acs: URL;
  let origin: URL;
  try { acs = new URL(provider.acsUrl); origin = new URL(config.federationPublicOrigin); }
  catch { throw new SamlError("saml_provider_invalid", 503, "SAML provider configuration is invalid"); }
  const expectedPath = "/api/auth/saml/" + provider.providerId + "/acs";
  if (acs.origin !== origin.origin || acs.pathname !== expectedPath || acs.search || acs.hash || acs.username || acs.password) {
    throw new SamlError("saml_acs_invalid", 503, "SAML ACS configuration is invalid");
  }
  if (provider.issuer !== provider.idpEntityId || provider.samlNameIdFormat !== SAML_PERSISTENT_NAME_ID || !provider.samlWantAssertionsSigned || !provider.samlWantAuthnResponseSigned) {
    throw new SamlError("saml_provider_invalid", 503, "SAML provider configuration is invalid");
  }
  return provider;
}

/**
 * Node-SAML exposes get/remove rather than an atomic consume hook. This cache
 * therefore reads only the durable pending transaction; the SAML service
 * performs the final SQLite BEGIN IMMEDIATE consume after the library has
 * verified the response and assertion. removeAsync is intentionally a no-op
 * so the library cannot consume a transaction before those checks complete.
 */
class DurableSamlCacheProvider implements CacheProvider {
  constructor(
    private readonly transactions: FederationTransactionStore,
    private readonly providerId: string,
    private readonly pending: PendingRow
  ) {}

  saveAsync(key: string, value: string): Promise<CacheItem | null> {
    if (key !== this.pending.requestId || !this.transactions.isRequestPending({ protocol: "saml", providerId: this.providerId, requestId: key })) return Promise.resolve(null);
    return Promise.resolve({ value, createdAt: Date.now() });
  }

  getAsync(key: string): Promise<string | null> {
    return Promise.resolve(this.transactions.isRequestPending({ protocol: "saml", providerId: this.providerId, requestId: key }) ? new Date().toISOString() : null);
  }

  removeAsync(key: string | null): Promise<string | null> {
    return Promise.resolve(key === this.pending.requestId ? key : null);
  }
}

export class SamlService {
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
    this.loginLimiter = new BoundedRateLimiter(config.authRateLimitMax, config.authRateLimitWindowSeconds, config.authRateLimitMaxClients);
    this.callbackLimiter = new BoundedRateLimiter(config.authRateLimitMax * 2, config.authRateLimitWindowSeconds, config.authRateLimitMaxClients);
  }

  async start(providerId: string, returnTo: string | null, context: SamlRequestContext): Promise<SamlLoginResult> {
    if (!this.loginLimiter.allow(context.ip + ":" + providerId)) throw new SamlError("saml_rate_limited", 429, "too many SAML requests");
    const provider = this.requireProvider(providerId);
    const returnPath = safeSamlReturnPath(returnTo);
    const browserBinding = crypto.randomBytes(32).toString("base64url");
    const state = crypto.randomBytes(32).toString("base64url");
    const requestId = "_" + crypto.randomBytes(32).toString("base64url");
    const callbackBinding = samlDigest(provider.acsUrl + "\u0000" + browserBinding);
    const transaction = this.transactions.create({ protocol: "saml", providerId: provider.providerId, callbackBinding, state, requestId, returnPath, ttlSeconds: SAML_TRANSACTION_TTL_SECONDS });
    const pending = this.transactions.pending(transaction.transactionId);
    if (!pending?.requestId) throw new SamlError("saml_transaction_invalid", 500, "SAML transaction is unavailable");
    const pendingWithRequestId = withRequestId(pending);
    try {
      const strategy = this.strategy(provider, pendingWithRequestId);
      const location = await strategy.getAuthorizeUrlAsync(state, undefined, {});
      this.auditEvent("federation.saml.started", provider.providerId, context.requestId, "committed");
      return { location, correlationCookie: createSamlCorrelation(this.config.authSessionSecret ?? "", transaction.transactionId, browserBinding) };
    } catch (error) {
      this.auditEvent("federation.saml.rejected", provider.providerId, context.requestId, "rejected");
      if (error instanceof SamlError) throw error;
      throw new SamlError("saml_unavailable", 503, "SAML authentication is unavailable");
    }
  }

  async complete(providerId: string, samlResponse: string, relayState: string | null, correlationCookie: string | undefined, sessionCookie: string | undefined, context: SamlRequestContext): Promise<SamlCallbackResult> {
    if (!this.callbackLimiter.allow(context.ip + ":" + providerId)) throw new SamlError("saml_rate_limited", 429, "too many SAML requests");
    const provider = this.requireProvider(providerId);
    const correlation = this.config.authSessionSecret ? parseSamlCorrelation(this.config.authSessionSecret, correlationCookie) : null;
    if (!correlation) throw new SamlError("saml_browser_binding_failed", 401, "SAML browser correlation failed");
    const callbackBinding = samlDigest(provider.acsUrl + "\u0000" + correlation.binding);
    const pending = this.transactions.pending(correlation.transactionId);
    if (!pending && this.transactions.wasConsumed(correlation.transactionId)) throw new SamlError("saml_replay_rejected", 409, "SAML response was already used");
    if (!pending || pending.protocol !== "saml" || pending.providerId !== provider.providerId || pending.callbackBinding !== callbackBinding || !pending.requestId) {
      throw new SamlError("saml_transaction_invalid", 400, "SAML transaction is invalid");
    }
    const pendingWithRequestId = withRequestId(pending);
    if (pending.expiresAt <= Date.now()) throw new SamlError("saml_transaction_expired", 400, "SAML transaction expired");
    const safeRelayState = boundedSamlValue(relayState, this.config.samlMaxRelayStateBytes);
    if (!safeRelayState || safeRelayState.length < 32) throw new SamlError("saml_relay_state_invalid", 400, "SAML RelayState is invalid");
    if (Buffer.byteLength(samlResponse, "utf8") > this.config.samlMaxResponseBytes || !/^[A-Za-z0-9+/=_-]+$/.test(samlResponse)) {
      throw new SamlError("saml_response_too_large", 413, "SAML response is too large");
    }
    let envelope: { readonly responseId: string };
    try {
      envelope = responseEnvelope(samlResponse, provider.acsUrl as string);
    } catch (error) {
      const category = error instanceof SamlEnvelopeError ? `envelope_${error.category}` : "envelope";
      this.auditEvent("federation.saml.validation_failed", provider.providerId, context.requestId, "rejected", "validation:" + category);
      this.auditEvent("federation.saml.rejected", provider.providerId, context.requestId, "rejected", "validation:" + category);
      throw new SamlError("saml_response_invalid", 401, "SAML authentication response is invalid");
    }
    let profile: Profile | null;
    try {
      const strategy = this.strategy(provider, pendingWithRequestId);
      const result = await strategy.validatePostResponseAsync({ SAMLResponse: samlResponse });
      profile = result.profile;
    } catch (error) {
      const category = validationCategory(error);
      const embeddedCertificate = embeddedCertificateFingerprint(samlResponse);
      const signatureDiagnostic = signatureDiagnosticCode(samlResponse, provider.samlTrustedCertificatesPem);
      const diagnosticTarget = "validation:" + category + (embeddedCertificate === null ? ":certificate:none" : ":certificate:" + embeddedCertificate) + (signatureDiagnostic === null ? "" : ":" + signatureDiagnostic);
      this.auditEvent("federation.saml.validation_failed", provider.providerId, context.requestId, "rejected", diagnosticTarget);
      this.auditEvent("federation.saml.rejected", provider.providerId, context.requestId, "rejected", diagnosticTarget);
      if (error instanceof SamlError) throw error;
      throw new SamlError("saml_response_invalid", 401, "SAML authentication response is invalid");
    }
    if (!profile || profile.issuer !== provider.idpEntityId || profile.nameIDFormat !== SAML_PERSISTENT_NAME_ID || !boundedSamlValue(profile.nameID, 512)) {
      throw new SamlError("saml_identity_invalid", 401, "SAML identity is invalid");
    }
    if (profile.inResponseTo !== pending.requestId) throw new SamlError("saml_in_response_to_invalid", 401, "SAML response correlation is invalid");
    verifiedRecipient(profile, provider.acsUrl as string, pending.requestId);
    const assertionIdentifier = assertionId(profile);
    let transaction;
    try {
      transaction = this.transactions.consumeByRequestId({ protocol: "saml", providerId: provider.providerId, requestId: pending.requestId, state: safeRelayState, callbackBinding });
      this.transactions.recordReplays("saml", provider.providerId, ["assertion:" + assertionIdentifier, "response:" + envelope.responseId, "response-digest:" + samlDigest(samlResponse)]);
    } catch (error) {
      if (error instanceof FederationTransactionError && error.code === "federation_transaction_replayed") throw new SamlError("saml_replay_rejected", 409, "SAML response was already used");
      if (error instanceof FederationTransactionError && error.code === "federation_transaction_expired") throw new SamlError("saml_transaction_expired", 400, "SAML transaction expired");
      throw new SamlError("saml_transaction_invalid", 400, "SAML transaction is invalid");
    }
    const email = profileAttribute(profile, ["email", "mail", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3"], 254);
    const username = profileAttribute(profile, ["preferred_username", "uid", "userPrincipalName", "email"], 80);
    const displayName = profileAttribute(profile, ["displayName", "name"], 160);
    const externalIdentity = ValidatedExternalIdentity.fromProtocolAdapter({
      protocol: "saml",
      providerId: provider.providerId,
      issuer: profile.issuer,
      subject: profile.nameID,
      ...(email ? { email } : {}),
      ...(username ? { username } : {}),
      ...(displayName ? { displayName } : {}),
      authenticatedAt: new Date().toISOString()
    });
    let resolved;
    try { resolved = this.identities.resolve(externalIdentity); }
    catch (error) {
      if (error instanceof FederationIdentityError && error.code === "federation_identity_unknown") {
        const linkChallenge = this.linkChallenges.stage(externalIdentity);
        throw new SamlError("saml_identity_link_required", 401, "SAML identity is not linked", { link_challenge: linkChallenge });
      }
      if (error instanceof FederationIdentityError && error.code === "federation_identity_email_required") throw new SamlError("saml_identity_email_required", 401, "SAML identity did not provide a usable email");
      if (error instanceof FederationIdentityError && error.code === "federation_identity_conflict") throw new SamlError("saml_identity_conflict", 409, "SAML identity requires an explicit account link");
      if (error instanceof FederationIdentityError && error.code === "federation_account_disabled") throw new SamlError("saml_account_disabled", 403, "SAML authentication is unavailable");
      throw error;
    }
    const current = this.auth.context(sessionCookie, undefined);
    const session = this.auth.rotateSession(current.session, resolved.userId);
    if (!session) throw new SamlError("saml_session_unavailable", 503, "authentication session is unavailable");
    this.auditEvent("federation.saml.succeeded", provider.providerId, context.requestId, "committed", samlDigest(provider.issuer + "\u0000" + profile.nameID).slice(0, 32));
    return { userId: resolved.userId, returnPath: transaction.returnPath, sessionCookie: session.cookieValue };
  }

  metadata(providerId: string): Promise<string> {
    const provider = this.requireProvider(providerId);
    const strategy = this.strategy(provider, null);
    return Promise.resolve(strategy.generateServiceProviderMetadata(null, provider.samlSignAuthnRequests ? validateSamlCertificate(provider.samlSpCertificatePem, "saml_sp_certificate_pem") : null));
  }

  private strategy(provider: FederationProviderConfig, pending: PendingRow | null): SAML {
    const idpCerts = provider.samlTrustedCertificatesPem.map((item) => validateSamlCertificate(item, "saml_idp_certificate_pem"));
    let privateKey: string | undefined;
    if (provider.samlSignAuthnRequests) {
      if (!provider.signingKeyReference) throw new SamlError("saml_signing_key_missing", 503, "SAML signing key is unavailable");
      try { privateKey = this.secrets.decryptProviderSecret(this.database, provider.providerId, "saml-sp-signing-private-key"); }
      catch (error) {
        if (error instanceof SecretStorageError) throw new SamlError("saml_signing_key_unavailable", 503, "SAML signing key is unavailable");
        throw error;
      }
    }
    const cacheProvider: CacheProvider = pending
      ? new DurableSamlCacheProvider(this.transactions, provider.providerId, pending)
      : { saveAsync: () => Promise.resolve(null), getAsync: () => Promise.resolve(null), removeAsync: () => Promise.resolve(null) };
    return new SAML({
      entryPoint: provider.samlEntryPoint as string,
      idpIssuer: provider.idpEntityId as string,
      idpCert: idpCerts.length === 1 ? idpCerts[0] as string : idpCerts,
      issuer: provider.spEntityId as string,
      callbackUrl: provider.acsUrl as string,
      identifierFormat: provider.samlNameIdFormat,
      allowCreate: false,
      acceptedClockSkewMs: provider.samlAcceptedClockSkewMs,
      disableRequestedAuthnContext: true,
      authnContext: [],
      forceAuthn: false,
      passive: false,
      skipRequestCompression: false,
      audience: provider.spEntityId as string,
      wantAssertionsSigned: provider.samlWantAssertionsSigned,
      wantAuthnResponseSigned: provider.samlWantAuthnResponseSigned,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: SAML_TRANSACTION_TTL_SECONDS * 1000,
      cacheProvider,
      generateUniqueId: () => pending?.requestId ?? "_" + crypto.randomBytes(32).toString("base64url"),
      ...(privateKey === undefined ? {} : { privateKey, publicCert: validateSamlCertificate(provider.samlSpCertificatePem, "saml_sp_certificate_pem"), signatureAlgorithm: "sha256" as const, digestAlgorithm: "sha256" })
    });
  }

  private requireProvider(providerId: string): FederationProviderConfig {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(providerId)) throw new SamlError("saml_provider_invalid", 400, "SAML provider is invalid");
    try { return samlProvider(this.providers.enabled(providerId, "saml"), this.config); }
    catch (error) {
      if (error instanceof SamlError) throw error;
      if (error instanceof FederationProviderError) throw new SamlError(error.code, error.statusCode, error.message);
      throw error;
    }
  }

  private auditEvent(action: string, providerId: string, requestId: string, outcome: "attempted" | "committed" | "failed" | "rejected", targetId = providerId): void {
    try { this.audit.append({ actor_user_id: 0, target_type: "saml_provider", target_id: targetId, action, outcome, request_id: requestId }); } catch { /* audit failure never changes the authentication result */ }
  }
}
