import type Database from "better-sqlite3";

import type { BackendConfig } from "../config/env.js";
import { openAuthWriteDatabase, type ReadonlyDatabase, type ReadonlyDatabaseManager } from "../db/readonly.js";
import { isAccountEnabled } from "./account-state.js";
import { verifyWerkzeugPasswordHash } from "./password.js";
import { PasswordWorkflow } from "./password-workflow.js";
import { generateWerkzeugScryptHash } from "./password-hash.js";
import { revokedBefore } from "./revocation.js";
import {
  ANONYMOUS,
  authenticateBearer,
  loadPrincipalById,
  normalizeRole,
  principalFromUserRow,
  type Principal,
  type Role
} from "./principal.js";
import { SessionStore, type SessionRecord } from "./session.js";
import {
  createUserToken,
  listUserTokens,
  revokeUserToken,
  updateUserToken,
} from "./token-management.js";
import type { EmailService } from "../email/service.js";
import type { RuntimePolicy } from "../settings/runtime-policy.js";
import {
  AuthConflictError,
  AuthWriteDisabledError,
} from "./errors.js";
import {
  authScalar,
  normalizeDisplayName,
  validateAccountInput,
} from "./validation.js";
import { RegistrationWorkflow } from "./registration-workflow.js";
import type { AuthWorkflowDependencies } from "./workflow-context.js";

export {
  AuthConflictError,
  AuthValidationError,
  AuthWriteDisabledError,
} from "./errors.js";
export { validatePassword } from "./validation.js";

export interface AuthServiceOptions {
  readonly config: BackendConfig;
  readonly readonlyDatabase: ReadonlyDatabaseManager;
  readonly email?: EmailService;
  readonly runtimePolicy?: RuntimePolicy;
}

export interface AuthRequestContext {
  readonly principal: Principal;
  readonly session: SessionRecord | null;
  readonly bearerOnly: boolean;
}

export class AuthService {
  readonly sessions: SessionStore | null;
  private readonly writeDatabase: ReadonlyDatabase | null;
  private readonly registrationWorkflow: RegistrationWorkflow;
  private readonly passwordWorkflow: PasswordWorkflow;
  private runtimePolicy: RuntimePolicy | undefined;

  constructor(private readonly options: AuthServiceOptions) {
    this.runtimePolicy = options.runtimePolicy;
    this.writeDatabase = options.config.authWriteEnabled ? openAuthWriteDatabase(options.config) : null;
    this.sessions = this.writeDatabase && options.config.authSessionSecret
      ? new SessionStore(options.config.authSessionSecret, () => this.runtimePolicy?.sessionLifetimeSeconds() ?? options.config.authSessionLifetimeSeconds, this.writeDatabase.sqlite)
      : null;
    const workflowDependencies: AuthWorkflowDependencies = {
      database: () => this.database(),
      writableDatabase: () => this.writableDatabase(),
      email: () => this.options.email,
      runtimePolicy: () => this.runtimePolicy,
      sessions: () => this.sessions,
    };
    this.registrationWorkflow = new RegistrationWorkflow(workflowDependencies);
    this.passwordWorkflow = new PasswordWorkflow(workflowDependencies);
  }

  setRuntimePolicy(policy: RuntimePolicy): void { this.runtimePolicy = policy; }

  sessionLifetimeSeconds(): number {
    return this.runtimePolicy?.sessionLifetimeSeconds() ?? this.options.config.authSessionLifetimeSeconds;
  }

  close(): void {
    this.writeDatabase?.close();
  }

  invalidateAllSessions(): void {
    this.sessions?.clear();
  }

  isWriteEnabled(): boolean {
    return this.writeDatabase !== null;
  }

  database(): Database.Database {
    return (this.writeDatabase ?? this.options.readonlyDatabase.get()).sqlite;
  }

  writableDatabase(): Database.Database {
    if (!this.writeDatabase) throw new AuthWriteDisabledError();
    return this.writeDatabase.sqlite;
  }

  context(cookieValue: string | undefined, bearerToken: string | undefined): AuthRequestContext {
    const session = this.sessions?.get(cookieValue) ?? null;
    try {
      const database = this.database();
      if (session?.userId !== null && session?.userId !== undefined) {
        if (session.createdAt > revokedBefore(database, session.userId) && isAccountEnabled(database, session.userId)) {
          const principal = loadPrincipalById(database, session.userId, "session");
          if (principal.authenticated) return { principal, session, bearerOnly: false };
        }
      }
      if (bearerToken) {
        const principal = authenticateBearer(database, bearerToken, this.isWriteEnabled());
        if (principal.authenticated) return { principal, session, bearerOnly: !session };
      }
    } catch {
      // Shadow/readiness failures must never turn into an auth bypass or an
      // exception that leaks the configured database path.
    }
    return { principal: ANONYMOUS, session, bearerOnly: false };
  }

  csrfToken(session: SessionRecord | null): string | null {
    return session?.csrfToken ?? null;
  }

  issueAnonymousSession(): { readonly record: SessionRecord; readonly cookieValue: string } {
    if (!this.sessions) throw new AuthWriteDisabledError();
    return this.sessions.issue(null);
  }

  rotateSession(old: SessionRecord | null, userId: number): { readonly record: SessionRecord; readonly cookieValue: string } | null {
    if (!this.sessions) return null;
    if (!isAccountEnabled(this.database(), userId)) return null;
    const minimum = revokedBefore(this.database(), userId) + 1;
    return this.sessions.rotate(old, userId, Math.max(Date.now(), minimum));
  }

  recentAdminReauthenticate(session: SessionRecord, password: string): boolean {
    if (session.userId === null) return false;
    const row = this.database().prepare("SELECT password_hash, role, disabled_at, account_status FROM users WHERE id = ?").get(session.userId) as {
      password_hash: string | null; role: string; disabled_at: string | null; account_status?: string | null
    } | undefined;
    if (!row || row.role !== "admin" || !isAccountEnabled(this.database(), session.userId) || !row.password_hash) return false;
    const result = verifyWerkzeugPasswordHash(row.password_hash, password);
    if (result.status !== "valid") return false;
    this.sessions?.recordRecentReauthentication(session);
    return true;
  }

  reauthenticate(session: SessionRecord, password: string): boolean {
    if (session.userId === null) return false;
    const row = this.database().prepare("SELECT password_hash FROM users WHERE id = ?").get(session.userId) as { password_hash: string | null } | undefined;
    if (!row?.password_hash || !isAccountEnabled(this.database(), session.userId)) return false;
    const result = verifyWerkzeugPasswordHash(row.password_hash, password);
    if (result.status !== "valid") return false;
    this.sessions?.recordRecentReauthentication(session);
    return true;
  }

  hasRecentReauthentication(session: SessionRecord): boolean {
    return session.reauthenticatedAt !== null && session.reauthenticatedAt >= Date.now() - this.options.config.authRecentReauthSeconds * 1000;
  }

  login(username: string, password: string): Principal {
    const db = this.writableDatabase();
    const row = db.prepare(
      "SELECT id, username, display_name, email, password_hash, role, external_provider, disabled_at, account_status FROM users WHERE username = ? OR email = ?"
    ).get(username.trim(), username.trim().toLowerCase()) as {
      id: number; username: string; display_name?: string | null; email: string; password_hash: string | null; role: string; external_provider: string | null; disabled_at: string | null; account_status?: string | null
    } | undefined;
    if (!row?.password_hash || !isAccountEnabled(db, row.id)) return ANONYMOUS;
    const result = verifyWerkzeugPasswordHash(row.password_hash, password);
    if (result.status !== "valid") return ANONYMOUS;
    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(row.id);
    return principalFromUserRow(db, row, "session");
  }

  bootstrap(payload: Record<string, unknown>): Principal {
    const db = this.writableDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const principal = this.bootstrapWithinTransaction(payload, db);
      db.exec("COMMIT");
      return principal;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Create the first administrator while the caller owns an existing
   * transaction.  The setup wizard uses this to commit the account and its
   * installation-state transition atomically; the legacy bootstrap route
   * continues to use bootstrap() above.
   */
  bootstrapWithinTransaction(payload: Record<string, unknown>, db = this.writableDatabase()): Principal {
    const username = authScalar(payload.username).trim();
    const email = authScalar(payload.email).trim().toLowerCase();
    const password = authScalar(payload.password);
    const confirmation = authScalar(payload.password_confirm, password);
    validateAccountInput(username, email, password, confirmation);
    let userId = 0;
    const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' OR username = 'admin' LIMIT 1").get();
    const completed = db.prepare("SELECT value FROM store_settings WHERE key = 'auth_bootstrap_completed'").get() as { value?: string } | undefined;
    if (existingAdmin || completed?.value === "true") {
      throw new AuthConflictError("bootstrap already completed");
    }
    try {
      const result = db.prepare(
        "INSERT INTO users(username, email, password_hash, role) VALUES (?, ?, ?, 'admin')"
      ).run(username, email, generateWerkzeugScryptHash(password));
      userId = Number(result.lastInsertRowid);
      db.prepare("INSERT OR IGNORE INTO groups(name) VALUES ('editors')").run();
      const group = db.prepare("SELECT id FROM groups WHERE name = 'editors'").get() as { id: number };
      db.prepare("INSERT OR IGNORE INTO user_groups(user_id, group_id) VALUES (?, ?)").run(userId, group.id);
      db.prepare(
        "INSERT INTO store_settings(key, value) VALUES ('auth_bootstrap_completed', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run();
    } catch (error) {
      if (error instanceof AuthConflictError) throw error;
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new AuthConflictError("username or email already exists");
      }
      throw error;
    }
    return loadPrincipalById(db, userId, "session");
  }

  async requestRegistration(email: string): Promise<void> {
    await this.registrationWorkflow.requestRegistration(email);
  }

  async requestRegistrationDetails(payload: Record<string, unknown>): Promise<{ readonly email: string }> {
    return this.registrationWorkflow.requestRegistrationDetails(payload);
  }

  completeRegistration(payload: Record<string, unknown>): Principal {
    return this.registrationWorkflow.completeRegistration(payload);
  }

  emailMessages(): readonly Record<string, unknown>[] {
    return this.options.email?.testMessages().map((message) => ({ to: message.to, from: message.from, subject: message.subject, text: message.text, html: message.html, created_at: message.createdAt })) ?? [];
  }

  changePassword(userId: number, currentPassword: string, password: string, confirmation: string): void {
    this.passwordWorkflow.changePassword(userId, currentPassword, password, confirmation);
  }

  async requestPasswordReset(identifier: string): Promise<void> {
    await this.passwordWorkflow.requestPasswordReset(identifier);
  }

  completePasswordReset(token: string, password: string, confirmation: string): void {
    this.passwordWorkflow.completePasswordReset(token, password, confirmation);
  }

  updateDisplayName(userId: number, displayName: string): Principal {
    const normalized = normalizeDisplayName(displayName);
    const database = this.writableDatabase();
    database.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(normalized, userId);
    return loadPrincipalById(database, userId, "session");
  }

  listTokens(userId: number): Array<Record<string, unknown>> {
    return listUserTokens(this.database(), userId);
  }

  createToken(userId: number, label: string): Record<string, unknown> {
    return createUserToken(this.writableDatabase(), userId, label);
  }

  updateToken(userId: number, tokenId: number, label: string): boolean {
    return updateUserToken(this.writableDatabase(), userId, tokenId, label);
  }

  revokeToken(userId: number, tokenId: number): boolean {
    return revokeUserToken(this.writableDatabase(), userId, tokenId);
  }
}

export { generateWerkzeugScryptHash } from "./password-hash.js";

export function configuredRole(value: string): Role {
  return normalizeRole(value);
}
