import crypto from "node:crypto";

import type Database from "better-sqlite3";

import { SetupError } from "./errors.js";
import { isSetupRecord, parseSetupSteps, setupBooleanValue, type SetupRow } from "./codecs.js";
import {
  SETUP_STEPS,
  type SetupServiceOptions,
  type SetupSession,
  type SetupState,
  type SetupStep,
} from "./service-contracts.js";
import {
  readApplicationMdnsPreference,
  readSetupInfrastructure,
} from "./infrastructure.js";
import { buildSetupProgress, buildSetupStatus } from "./read-model.js";
import {
  importSamlSetupMetadata,
  SetupProviderStepHandlers,
  validateOidcSetup,
} from "./provider-step-handlers.js";

export { SETUP_STATES, SETUP_STEPS } from "./service-contracts.js";
export type {
  SetupServiceOptions,
  SetupSession,
  SetupState,
  SetupStep,
} from "./service-contracts.js";
export { SetupError } from "./errors.js";

const SETUP_SESSION_SECONDS = 15 * 60;
const SETUP_SESSION_COOKIE = "prg32_setup_session";
const MAX_SETUP_PAYLOAD_BYTES = 64 * 1024;

function now(): string { return new Date().toISOString(); }

export class SetupService {
  private readonly sessions = new Map<string, SetupSession>();
  private readonly providerStepHandlers: SetupProviderStepHandlers;
  private activeSessionId: string | null = null;

  constructor(private readonly options: SetupServiceOptions) {
    this.providerStepHandlers = new SetupProviderStepHandlers({
      options,
      apiOrigin: () => this.apiOrigin(),
      adminUserId: () => this.row().admin_user_id as number,
      markStep: (session, step, requestId) =>
        this.markStep(session, step, requestId),
    });
    this.reconcileExistingInstallation();
  }

  static cookieName(): string { return SETUP_SESSION_COOKIE; }
  static sessionLifetimeSeconds(): number { return SETUP_SESSION_SECONDS; }

  private reconcileExistingInstallation(): void {
    if (!this.options.database) return;
    const database = this.options.database;
    const current = database.prepare("SELECT state FROM setup_state WHERE singleton_id = 1").get() as { state?: SetupState } | undefined;
    if (!current || current.state !== "INSTALLATION_REQUIRED") return;
    const admin = database.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as { id?: number } | undefined;
    if (admin?.id !== undefined) {
      database.prepare("UPDATE setup_state SET state = 'INSTALLATION_COMPLETE', completed_steps_json = '[\"admin\"]', admin_user_id = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE singleton_id = 1 AND state = 'INSTALLATION_REQUIRED'").run(admin.id, now(), now());
      return;
    }
    const users = database.prepare("SELECT 1 FROM users LIMIT 1").get();
    if (users) database.prepare("UPDATE setup_state SET state = 'INSTALLATION_RECOVERY_REQUIRED', recovery_reason = 'existing accounts require operator recovery', updated_at = ? WHERE singleton_id = 1 AND state = 'INSTALLATION_REQUIRED'").run(now());
  }

  legacyBootstrapAllowed(): boolean {
    return this.options.config.authWriteMode === "test" || (this.options.database !== null && this.row().state === "INSTALLATION_COMPLETE");
  }

  private get database(): Database.Database {
    if (!this.options.database) throw new SetupError("infrastructure_not_ready", 503, "installation infrastructure is not ready");
    return this.options.database;
  }

  private row(): SetupRow {
    const row = this.database.prepare("SELECT state, completed_steps_json, admin_user_id, recovery_reason, started_at, completed_at FROM setup_state WHERE singleton_id = 1").get() as SetupRow | undefined;
    if (!row) throw new SetupError("setup_state_unavailable", 503, "installation state is unavailable");
    return row;
  }

  status(): Record<string, unknown> {
    const infrastructure = readSetupInfrastructure(this.options);
    if (!this.options.database) return {
      ok: true,
      state: "INFRASTRUCTURE_NOT_READY",
      setup_required: false,
      authorization_required: false,
      infrastructure,
      public_origins: { store: this.options.config.frontendPublicOrigin ?? null, api: this.options.config.federationPublicOrigin ?? this.options.config.oidcPublicOrigin ?? null },
      mdns: { infrastructure_allowed: false, application_enabled: false, effective_enabled: false, service_type: "_prg32store._tcp.local.", abi: "prg32-store-discovery-1.0", port: this.options.config.mdnsPort, restart_required: true }
    };
    const row = this.row();
    const applicationMdnsEnabled = readApplicationMdnsPreference(this.database);
    return buildSetupStatus(
      this.options,
      infrastructure,
      row,
      applicationMdnsEnabled,
    );
  }

  progress(session: SetupSession): Record<string, unknown> {
    this.requireSession(session);
    const row = this.row();
    return buildSetupProgress(
      row,
      session,
      this.options.settings.read(),
      this.options.providers?.list() ?? [],
    );
  }

  authorize(token: string): { readonly session: SetupSession; readonly progress: Record<string, unknown> } {
    const infrastructure = readSetupInfrastructure(this.options);
    const state = this.row().state;
    if (!infrastructure.ready) throw new SetupError("infrastructure_not_ready", 503, "installation infrastructure is not ready");
    if (state === "INSTALLATION_COMPLETE") throw new SetupError("setup_already_complete", 409, "installation is already complete");
    if (state === "INSTALLATION_RECOVERY_REQUIRED") throw new SetupError("setup_recovery_required", 409, "installation recovery requires operator intervention");
    const expectedToken = this.options.config.authBootstrapToken ? Buffer.from(this.options.config.authBootstrapToken) : null;
    const providedToken = Buffer.from(token ?? "");
    if (!expectedToken || expectedToken.length !== providedToken.length || !crypto.timingSafeEqual(expectedToken, providedToken)) {
      throw new SetupError("setup_authorization_invalid", 403, "installation authorization is invalid");
    }
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) throw new SetupError("setup_session_conflict", 409, "another installation session is active");
    const session: SetupSession = { id: crypto.randomBytes(32).toString("base64url"), csrfToken: crypto.randomBytes(32).toString("base64url"), expiresAt: Date.now() + SETUP_SESSION_SECONDS * 1000 };
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.row();
      if (current.state === "INSTALLATION_REQUIRED") {
        this.database.prepare("UPDATE setup_state SET state = 'INSTALLATION_IN_PROGRESS', started_at = COALESCE(started_at, ?), updated_at = ? WHERE singleton_id = 1").run(now(), now());
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      this.sessions.delete(session.id);
      this.activeSessionId = null;
      throw new SetupError("setup_state_unavailable", 503, "installation state could not be updated", { cause: error });
    }
    return { session, progress: this.progress(session) };
  }

  session(id: string | undefined): SetupSession | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(id);
      if (this.activeSessionId === id) this.activeSessionId = null;
      return null;
    }
    return session;
  }

  invalidate(session: SetupSession): void {
    this.sessions.delete(session.id);
    if (this.activeSessionId === session.id) this.activeSessionId = null;
  }

  requireSession(session: SetupSession | null): asserts session is SetupSession {
    if (!session) throw new SetupError("setup_authorization_required", 401, "installation authorization is required");
    if (session.expiresAt <= Date.now()) throw new SetupError("setup_authorization_expired", 401, "installation authorization has expired");
    const state = this.row().state;
    if (state === "INSTALLATION_COMPLETE") throw new SetupError("setup_already_complete", 409, "installation is already complete");
    if (state === "INSTALLATION_RECOVERY_REQUIRED") throw new SetupError("setup_recovery_required", 409, "installation recovery requires operator intervention");
  }

  async saveStep(session: SetupSession, stepValue: unknown, payload: unknown, requestId: string): Promise<Record<string, unknown>> {
    this.requireSession(session);
    if (typeof stepValue !== "string" || !(SETUP_STEPS as readonly string[]).includes(stepValue)) throw new SetupError("setup_step_invalid", 400, "installation step is invalid");
    if (!isSetupRecord(payload) || Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SETUP_PAYLOAD_BYTES) throw new SetupError("setup_payload_invalid", 400, "installation step payload is invalid");
    const step = stepValue as SetupStep;
    const row = this.row();
    if (parseSetupSteps(row.completed_steps_json).includes(step)) return this.progress(session);
    if (step === "admin") this.saveAdmin(session, payload, requestId);
    else if (step === "store") await this.updateSettings(session, payload, ["application.store_name", "application.store_description", "application.contact_email"], requestId);
    else if (step === "registration") await this.updateSettings(session, payload, ["registration.enabled", "registration.require_email_verification"], requestId);
    else if (step === "security") await this.updateSettings(session, payload, ["session.lifetime_seconds", "publishing.enabled", "review.require_note_on_rejection", "security.notify_user_on_account_change"], requestId);
    else if (step === "smtp") await this.updateSettings(session, payload, ["smtp.enabled", "smtp.host", "smtp.port", "smtp.encryption", "smtp.secure", "smtp.auth_enabled", "smtp.username", "smtp.from_name", "smtp.from_email", "smtp.reply_to", "smtp.connection_timeout_ms", "smtp.password"], requestId);
    else if (step === "oidc") this.saveOidc(session, payload, requestId);
    else if (step === "saml") this.saveSaml(session, payload, requestId);
    else if (step === "mdns") await this.saveMdns(session, payload, requestId);
    else this.markStep(session, step, requestId);
    return this.progress(session);
  }

  private saveAdmin(session: SetupSession, payload: Record<string, unknown>, requestId: string): void {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.row();
      if (row.admin_user_id !== null || parseSetupSteps(row.completed_steps_json).includes("admin")) throw new SetupError("setup_admin_already_created", 409, "the initial administrator already exists");
      const principal = this.options.auth.bootstrapWithinTransaction(payload, db);
      const steps = JSON.stringify(["admin"]);
      db.prepare("UPDATE setup_state SET state = 'INSTALLATION_IN_PROGRESS', completed_steps_json = ?, admin_user_id = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE singleton_id = 1").run(steps, principal.id, now(), now());
      db.exec("COMMIT");
      this.audit(session, "setup.admin.created", String(principal.id), requestId, principal.id ?? null);
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      if (error instanceof SetupError) throw error;
      throw new SetupError("setup_admin_failed", 400, "initial administrator could not be created", { cause: error });
    }
  }

  private async updateSettings(session: SetupSession, payload: Record<string, unknown>, allowed: readonly string[], requestId: string, stepOverride?: SetupStep): Promise<void> {
    const application: Record<string, unknown> = {};
    for (const key of allowed) {
      const source = key === "smtp.password" ? key : key;
      if (Object.hasOwn(payload, source)) application[source] = payload[source];
    }
    const current = this.row();
    if (current.admin_user_id === null) throw new SetupError("setup_admin_required", 409, "create the initial administrator first");
    await this.options.settings.update({ application_settings: application }, { actorUserId: current.admin_user_id, requestId });
    this.markStep(session, stepOverride ?? this.currentStep(allowed), requestId);
  }

  private currentStep(allowed: readonly string[]): SetupStep {
    if (allowed.includes("application.store_name")) return "store";
    if (allowed.includes("registration.enabled")) return "registration";
    if (allowed.includes("session.lifetime_seconds")) return "security";
    return "smtp";
  }

  private saveOidc(session: SetupSession, payload: Record<string, unknown>, requestId: string): void {
    this.providerStepHandlers.saveOidc(session, payload, requestId);
  }

  private saveSaml(session: SetupSession, payload: Record<string, unknown>, requestId: string): void {
    this.providerStepHandlers.saveSaml(session, payload, requestId);
  }

  private async saveMdns(session: SetupSession, payload: Record<string, unknown>, requestId: string): Promise<void> {
    const enabled = setupBooleanValue(payload.enabled, "enabled", false);
    if (enabled && !this.options.config.mdnsEnabled) throw new SetupError("mdns_infrastructure_denied", 409, "mDNS is disabled by deployment policy");
    await this.updateSettings(session, { "discovery.mdns_enabled": enabled }, ["discovery.mdns_enabled"], requestId, "mdns");
  }

  private apiOrigin(): string {
    const origin = this.options.config.federationPublicOrigin ?? this.options.config.oidcPublicOrigin ?? this.options.config.frontendPublicOrigin;
    if (!origin) throw new SetupError("public_api_origin_unavailable", 503, "the public API origin is not configured");
    return origin.replace(/\/$/u, "");
  }

  private markStep(session: SetupSession, step: SetupStep, requestId: string): void {
    this.requireSession(session);
    const row = this.row();
    const steps = parseSetupSteps(row.completed_steps_json);
    if (!steps.includes(step)) steps.push(step);
    this.database.prepare("UPDATE setup_state SET state = CASE WHEN state = 'INSTALLATION_REQUIRED' THEN 'INSTALLATION_IN_PROGRESS' ELSE state END, completed_steps_json = ?, updated_at = ? WHERE singleton_id = 1").run(JSON.stringify(steps.sort()), now());
    if (row.admin_user_id !== null) this.audit(session, `setup.step.${step}`, step, requestId, row.admin_user_id);
  }

  complete(session: SetupSession, requestId: string): Record<string, unknown> {
    this.requireSession(session);
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    let adminId: number | null = null;
    try {
      const row = this.row();
      const steps = parseSetupSteps(row.completed_steps_json);
      const missing = SETUP_STEPS.filter((step) => !steps.includes(step));
      if (missing.length > 0 || row.admin_user_id === null) throw new SetupError("setup_steps_incomplete", 409, `installation steps are incomplete: ${missing.join(", ") || "admin"}`);
      if (row.state === "INSTALLATION_COMPLETE") throw new SetupError("setup_already_complete", 409, "installation is already complete");
      adminId = row.admin_user_id;
      db.prepare("UPDATE setup_state SET state = 'INSTALLATION_COMPLETE', completed_at = ?, updated_at = ?, recovery_reason = NULL WHERE singleton_id = 1").run(now(), now());
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      if (error instanceof SetupError) throw error;
      throw new SetupError("setup_completion_failed", 503, "installation could not be completed", { cause: error });
    }
    if (adminId !== null) this.audit(session, "setup.completed", "installation", requestId, adminId);
    this.invalidate(session);
    return { ok: true, state: "INSTALLATION_COMPLETE", redirect: "/auth/login" };
  }

  async testSmtpConnection(session: SetupSession): Promise<Record<string, unknown>> {
    this.requireSession(session);
    try { await this.options.settings.testSmtpConnection(); }
    catch { throw new SetupError("setup_smtp_test_failed", 502, "SMTP connection test failed"); }
    return { ok: true, result: "smtp_connection_ok" };
  }

  async sendSmtpTest(session: SetupSession, recipient: string): Promise<Record<string, unknown>> {
    this.requireSession(session);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(recipient) || recipient.length > 254) throw new SetupError("setup_smtp_recipient_invalid", 400, "test recipient is invalid");
    try { await this.options.settings.sendSmtpTest(recipient); }
    catch { throw new SetupError("setup_smtp_test_failed", 502, "SMTP test message could not be sent"); }
    return { ok: true, result: "smtp_message_accepted" };
  }

  async validateOidc(session: SetupSession, issuer: string): Promise<Record<string, unknown>> {
    return validateOidcSetup(
      session,
      issuer,
      this.options,
      (current) => this.requireSession(current),
    );
  }

  async importSamlMetadata(session: SetupSession, input: { readonly url?: string; readonly xml?: string }): Promise<Record<string, unknown>> {
    return importSamlSetupMetadata(
      session,
      input,
      this.options,
      (current) => this.requireSession(current),
    );
  }

  private audit(_session: SetupSession, action: string, targetId: string, requestId: string, actorUserId: number | null): void {
    if (!this.options.audit || actorUserId === null) return;
    try { this.options.audit.append({ actor_user_id: actorUserId, target_type: "installation", target_id: targetId, action, outcome: "committed", request_id: requestId }); } catch { /* setup state remains authoritative; diagnostics never expose secrets */ }
  }
}
