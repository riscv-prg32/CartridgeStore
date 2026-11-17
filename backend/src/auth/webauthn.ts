import crypto from "node:crypto";

import type Database from "better-sqlite3";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential
} from "@simplewebauthn/server";

import type { AdminAuditLog } from "../admin/audit.js";
import type { BackendConfig } from "../config/env.js";
import { isAccountEnabled } from "./account-state.js";
import type { AuthService } from "./service.js";
import type { SessionRecord } from "./session.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_NAME = 80;

export class WebAuthnError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
    this.name = "WebAuthnError";
  }
}

interface CredentialRow {
  credential_id: string;
  user_id: number;
  public_key: Buffer;
  signature_counter: number;
  device_type: "singleDevice" | "multiDevice";
  backed_up: number;
  transports_json: string;
  display_name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface ChallengeRow {
  challenge_id: string;
  ceremony: "registration" | "authentication";
  challenge: string;
  user_id: number | null;
  session_hash: string;
  expires_at: number;
  consumed_at: number | null;
}

function now(): string { return new Date().toISOString(); }
function sessionHash(session: SessionRecord): string { return crypto.createHash("sha256").update(session.id, "utf8").digest("hex"); }
function randomChallenge(): string { return crypto.randomBytes(32).toString("base64url"); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WebAuthnError("webauthn_response_invalid", 400, `${label} is invalid`);
  return value as Record<string, unknown>;
}
function safeName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Passkey";
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_NAME || [...value].some((item) => item.charCodeAt(0) < 32)) throw new WebAuthnError("webauthn_display_name_invalid", 400, "passkey name is invalid");
  return value.trim();
}
function activeCredential(row: CredentialRow): boolean { return row.revoked_at === null; }
function parseTransports(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length <= 32).slice(0, 8) : [];
  } catch { return []; }
}
function publicCredential(row: CredentialRow): Record<string, unknown> {
  return {
    id: row.credential_id,
    display_name: row.display_name,
    device_type: row.device_type,
    backed_up: row.backed_up === 1,
    transports: parseTransports(row.transports_json),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked: row.revoked_at !== null
  };
}

export class WebAuthnService {
  constructor(
    private readonly database: Database.Database,
    private readonly auth: AuthService,
    private readonly config: BackendConfig,
    private readonly audit?: AdminAuditLog
  ) {}

  enabled(): boolean { return this.config.webauthnEnabled; }

  private ensureEnabled(): void {
    if (!this.enabled()) throw new WebAuthnError("webauthn_disabled", 404, "passkey authentication is unavailable");
    if (!this.config.webauthnRpId || this.config.webauthnOrigins.length === 0) throw new WebAuthnError("webauthn_configuration_invalid", 503, "passkey authentication is unavailable");
  }

  private requireSessionUser(session: SessionRecord | null, userId: number): void {
    if (!session || session.userId !== userId) throw new WebAuthnError("webauthn_authentication_required", 401, "recent authentication is required");
    if (!this.auth.hasRecentReauthentication(session)) throw new WebAuthnError("webauthn_recent_auth_required", 403, "recent authentication is required before changing passkeys");
    if (!isAccountEnabled(this.database, userId)) throw new WebAuthnError("webauthn_account_unavailable", 403, "this account cannot use passkeys");
  }

  private cleanupChallenges(): void {
    this.database.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL AND consumed_at <= ?").run(Date.now(), Date.now() - CHALLENGE_TTL_MS);
  }

  async beginRegistration(userId: number, session: SessionRecord | null): Promise<Record<string, unknown>> {
    this.ensureEnabled();
    const rpId = this.config.webauthnRpId;
    if (!rpId) throw new WebAuthnError("webauthn_configuration_invalid", 503, "passkey authentication is unavailable");
    this.requireSessionUser(session, userId);
    const user = this.database.prepare("SELECT username, email FROM users WHERE id = ?").get(userId) as { username?: string; email?: string } | undefined;
    if (!user?.username || !user.email) throw new WebAuthnError("webauthn_account_unavailable", 403, "this account cannot use passkeys");
    const existing = this.database.prepare("SELECT credential_id, transports_json FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL").all(userId) as Array<{ credential_id: string; transports_json: string }>;
    const challenge = randomChallenge();
    const options = await generateRegistrationOptions({
      rpName: this.config.webauthnRpName,
      rpID: rpId,
      userName: user.username,
      userID: Buffer.from(String(userId), "utf8"),
      userDisplayName: user.username,
      challenge,
      timeout: 60_000,
      attestationType: "none",
      excludeCredentials: existing.map((item) => ({ id: item.credential_id, transports: parseTransports(item.transports_json) })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" }
    });
    this.cleanupChallenges();
    this.database.prepare("INSERT INTO webauthn_challenges(challenge_id, ceremony, challenge, user_id, session_hash, expires_at) VALUES (?, 'registration', ?, ?, ?, ?)").run(crypto.randomUUID(), options.challenge, userId, sessionHash(session as SessionRecord), Date.now() + CHALLENGE_TTL_MS);
    return options as unknown as Record<string, unknown>;
  }

  async finishRegistration(userId: number, session: SessionRecord | null, input: unknown, displayName: unknown): Promise<Record<string, unknown>> {
    this.ensureEnabled();
    const rpId = this.config.webauthnRpId;
    if (!rpId) throw new WebAuthnError("webauthn_configuration_invalid", 503, "passkey authentication is unavailable");
    this.requireSessionUser(session, userId);
    const response = record(input, "response") as unknown as RegistrationResponseJSON;
    if (typeof response.id !== "string" || response.id.length < 16 || response.id.length > 1024) throw new WebAuthnError("webauthn_response_invalid", 400, "passkey response is invalid");
    const challenge = this.database.prepare("SELECT * FROM webauthn_challenges WHERE ceremony = 'registration' AND user_id = ? AND session_hash = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1").get(userId, sessionHash(session as SessionRecord), Date.now()) as ChallengeRow | undefined;
    if (!challenge) throw new WebAuthnError("webauthn_challenge_invalid", 400, "passkey challenge is invalid or expired");
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: [...this.config.webauthnOrigins], expectedRPID: rpId, requireUserVerification: true });
    } catch {
      throw new WebAuthnError("webauthn_registration_invalid", 400, "passkey registration could not be verified");
    }
    if (!verification.verified) throw new WebAuthnError("webauthn_registration_invalid", 400, "passkey registration could not be verified");
    const info = verification.registrationInfo;
    const credentialId = info.credential.id;
    const name = safeName(displayName);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.database.prepare("UPDATE webauthn_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?").run(Date.now(), challenge.challenge_id, Date.now());
      if (consumed.changes !== 1) throw new WebAuthnError("webauthn_challenge_replayed", 409, "passkey challenge has already been used");
      if (this.database.prepare("SELECT 1 FROM webauthn_credentials WHERE credential_id = ?").get(credentialId)) throw new WebAuthnError("webauthn_credential_duplicate", 409, "this passkey is already registered");
      this.database.prepare("INSERT INTO webauthn_credentials(credential_id, user_id, public_key, signature_counter, device_type, backed_up, transports_json, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(credentialId, userId, Buffer.from(info.credential.publicKey), info.credential.counter, info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, JSON.stringify(response.response.transports ?? []), name, now());
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      if (error instanceof WebAuthnError) throw error;
      throw new WebAuthnError("webauthn_registration_failed", 400, "passkey registration could not be completed");
    }
    this.auditEvent(userId, "webauthn.credential.registered", credentialId, "committed");
    return { ok: true, credential: this.getCredential(userId, credentialId) };
  }

  async beginAuthentication(username: unknown, session: SessionRecord | null): Promise<Record<string, unknown>> {
    this.ensureEnabled();
    const rpId = this.config.webauthnRpId;
    if (!rpId) throw new WebAuthnError("webauthn_configuration_invalid", 503, "passkey authentication is unavailable");
    if (!session) throw new WebAuthnError("webauthn_session_required", 401, "authentication session is required");
    const normalized = typeof username === "string" && username.trim() ? username.trim() : null;
    let userId: number | null = null;
    if (normalized) {
      const row = this.database.prepare("SELECT id FROM users WHERE username = ? OR email = ?").get(normalized, normalized.toLowerCase()) as { id?: number } | undefined;
      userId = row?.id ?? null;
    }
    const credentials = userId === null ? [] : (this.database.prepare("SELECT credential_id, transports_json FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL").all(userId) as Array<{ credential_id: string; transports_json: string }>);
    const challenge = randomChallenge();
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      challenge,
      timeout: 60_000,
      userVerification: "required",
      ...(credentials.length > 0 ? { allowCredentials: credentials.map((item) => ({ id: item.credential_id, transports: parseTransports(item.transports_json) })) } : {})
    });
    this.cleanupChallenges();
    this.database.prepare("INSERT INTO webauthn_challenges(challenge_id, ceremony, challenge, user_id, session_hash, expires_at) VALUES (?, 'authentication', ?, ?, ?, ?)").run(crypto.randomUUID(), options.challenge, userId, sessionHash(session), Date.now() + CHALLENGE_TTL_MS);
    return options as unknown as Record<string, unknown>;
  }

  async finishAuthentication(session: SessionRecord | null, input: unknown): Promise<{ readonly userId: number; readonly sessionCookie: string }> {
    this.ensureEnabled();
    const rpId = this.config.webauthnRpId;
    if (!rpId) throw new WebAuthnError("webauthn_configuration_invalid", 503, "passkey authentication is unavailable");
    if (!session) throw new WebAuthnError("webauthn_session_required", 401, "authentication session is required");
    const response = record(input, "response") as unknown as AuthenticationResponseJSON;
    if (typeof response.id !== "string" || response.id.length < 16 || response.id.length > 1024) throw new WebAuthnError("webauthn_response_invalid", 400, "passkey response is invalid");
    const credential = this.database.prepare("SELECT * FROM webauthn_credentials WHERE credential_id = ?").get(response.id) as CredentialRow | undefined;
    const challenge = this.database.prepare("SELECT * FROM webauthn_challenges WHERE ceremony = 'authentication' AND session_hash = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1").get(sessionHash(session), Date.now()) as ChallengeRow | undefined;
    if (!credential || !activeCredential(credential) || !challenge || (challenge.user_id !== null && challenge.user_id !== credential.user_id)) throw new WebAuthnError("webauthn_authentication_invalid", 401, "passkey authentication could not be verified");
    const transports = parseTransports(credential.transports_json);
    const stored: WebAuthnCredential = transports.length > 0
      ? { id: credential.credential_id, publicKey: new Uint8Array(credential.public_key), counter: credential.signature_counter, transports }
      : { id: credential.credential_id, publicKey: new Uint8Array(credential.public_key), counter: credential.signature_counter };
    let verification;
    try {
      verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: [...this.config.webauthnOrigins], expectedRPID: rpId, credential: stored, requireUserVerification: true });
    } catch {
      throw new WebAuthnError("webauthn_authentication_invalid", 401, "passkey authentication could not be verified");
    }
    if (!verification.verified) throw new WebAuthnError("webauthn_authentication_invalid", 401, "passkey authentication could not be verified");
    const newCounter = verification.authenticationInfo.newCounter;
    if (credential.signature_counter !== 0 && newCounter !== 0 && newCounter < credential.signature_counter) throw new WebAuthnError("webauthn_counter_rollback", 401, "passkey authentication could not be verified");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.database.prepare("UPDATE webauthn_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?").run(Date.now(), challenge.challenge_id, Date.now());
      if (consumed.changes !== 1) throw new WebAuthnError("webauthn_challenge_replayed", 401, "passkey authentication could not be verified");
      if (!isAccountEnabled(this.database, credential.user_id)) throw new WebAuthnError("webauthn_account_unavailable", 403, "this account cannot use passkeys");
      const issued = this.auth.rotateSession(session, credential.user_id);
      if (!issued) throw new WebAuthnError("webauthn_session_unavailable", 503, "authentication session is unavailable");
      this.database.prepare("UPDATE webauthn_credentials SET signature_counter = ?, backed_up = ?, device_type = ?, last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL").run(newCounter, verification.authenticationInfo.credentialBackedUp ? 1 : 0, verification.authenticationInfo.credentialDeviceType, now(), credential.credential_id);
      this.database.exec("COMMIT");
      this.auditEvent(credential.user_id, "webauthn.credential.used", credential.credential_id, "committed");
      return { userId: credential.user_id, sessionCookie: issued.cookieValue };
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      if (error instanceof WebAuthnError) throw error;
      throw new WebAuthnError("webauthn_authentication_failed", 401, "passkey authentication could not be completed");
    }
  }

  list(userId: number): readonly Record<string, unknown>[] {
    this.ensureEnabled();
    return (this.database.prepare("SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at ASC, credential_id ASC").all(userId) as CredentialRow[]).map(publicCredential);
  }

  rename(userId: number, credentialId: string, session: SessionRecord | null, displayName: unknown): Record<string, unknown> {
    this.ensureEnabled(); this.requireSessionUser(session, userId); const name = safeName(displayName);
    const changed = this.database.prepare("UPDATE webauthn_credentials SET display_name = ? WHERE credential_id = ? AND user_id = ? AND revoked_at IS NULL").run(name, credentialId, userId);
    if (changed.changes !== 1) throw new WebAuthnError("webauthn_credential_unknown", 404, "passkey is not registered");
    this.auditEvent(userId, "webauthn.credential.renamed", credentialId, "committed");
    return { ok: true, credential: this.getCredential(userId, credentialId) };
  }

  revoke(userId: number, credentialId: string, session: SessionRecord | null): Record<string, unknown> {
    this.ensureEnabled(); this.requireSessionUser(session, userId);
    return this.revokeStored(userId, credentialId, userId);
  }

  revokeByAdministrator(actorUserId: number, targetUserId: number, credentialId: string, session: SessionRecord | null): Record<string, unknown> {
    this.ensureEnabled();
    if (!session || session.userId !== actorUserId || !this.auth.hasRecentReauthentication(session)) throw new WebAuthnError("webauthn_recent_auth_required", 403, "recent authentication is required before changing passkeys");
    const actor = this.database.prepare("SELECT role FROM users WHERE id = ?").get(actorUserId) as { role?: string } | undefined;
    if (actor?.role !== "admin") throw new WebAuthnError("webauthn_admin_required", 403, "administrator privileges are required");
    return this.revokeStored(targetUserId, credentialId, actorUserId);
  }

  private revokeStored(userId: number, credentialId: string, actorUserId: number): Record<string, unknown> {
    const credential = this.database.prepare("SELECT * FROM webauthn_credentials WHERE credential_id = ? AND user_id = ? AND revoked_at IS NULL").get(credentialId, userId) as CredentialRow | undefined;
    if (!credential) throw new WebAuthnError("webauthn_credential_unknown", 404, "passkey is not registered");
    const recovery = this.database.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string | null } | undefined;
    const remaining = (this.database.prepare("SELECT COUNT(*) AS count FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL").get(userId) as { count: number }).count;
    const federation = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_external_identities'").get() && this.database.prepare("SELECT 1 FROM user_external_identities WHERE user_id = ? AND unlinked_at IS NULL LIMIT 1").get(userId);
    if (remaining <= 1 && !recovery?.password_hash && !federation) throw new WebAuthnError("webauthn_last_credential", 409, "keep a recovery method before removing the last passkey");
    this.database.prepare("UPDATE webauthn_credentials SET revoked_at = ? WHERE credential_id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), credentialId, userId);
    this.auditEvent(actorUserId, "webauthn.credential.revoked", credentialId, "committed");
    return { ok: true };
  }

  private getCredential(userId: number, credentialId: string): Record<string, unknown> {
    const row = this.database.prepare("SELECT * FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?").get(userId, credentialId) as CredentialRow | undefined;
    if (!row) throw new WebAuthnError("webauthn_credential_unknown", 404, "passkey is not registered");
    return publicCredential(row);
  }

  private auditEvent(userId: number, action: string, credentialId: string, outcome: "committed" | "rejected"): void {
    try { this.audit?.append({ actor_user_id: userId, target_type: "webauthn_credential", target_id: crypto.createHash("sha256").update(credentialId, "utf8").digest("hex").slice(0, 32), action, outcome, request_id: "webauthn" }); } catch { /* auth success is not made dependent on optional audit storage */ }
  }
}
