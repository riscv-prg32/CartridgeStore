import crypto from "node:crypto";

import { EmailDeliveryError } from "../email/service.js";
import { AuthValidationError } from "./errors.js";
import {
  authScalar,
  AUTH_USERNAME_MAX_LENGTH,
  isValidAuthEmail,
  validatePassword,
} from "./validation.js";
import { hashApiToken } from "./tokens.js";
import { loadPrincipalById, type Principal } from "./principal.js";
import {
  ensureAuthWorkflowSchema,
  registrationDomain,
} from "./workflow-schema.js";
import type { AuthWorkflowDependencies } from "./workflow-context.js";
import { generateWerkzeugScryptHash } from "./password-hash.js";

/** Handles email registration requests and one-time registration completion. */
export class RegistrationWorkflow {
  constructor(private readonly dependencies: AuthWorkflowDependencies) {}

  /** Creates a registration request using the compatibility email-only form. */
  async requestRegistration(email: string): Promise<void> {
    await this.requestRegistrationDetails({ email });
  }

  /** Creates a registration token and sends its confirmation email. */
  async requestRegistrationDetails(
    payload: Record<string, unknown>,
  ): Promise<{ readonly email: string }> {
    const database = this.dependencies.writableDatabase();
    ensureAuthWorkflowSchema(database);
    const normalized = authScalar(payload.email).trim().toLowerCase();
    if (!isValidAuthEmail(normalized)) {
      throw new AuthValidationError("email must be valid");
    }
    const username = authScalar(payload.username, normalized).trim();
    const password = authScalar(payload.password);
    const confirmation = authScalar(payload.password_confirm, password);
    if (
      payload.username !== undefined ||
      payload.password !== undefined ||
      payload.password_confirm !== undefined
    ) {
      if (!username || username.length > AUTH_USERNAME_MAX_LENGTH) {
        throw new AuthValidationError(
          "username is required and must be at most 80 characters",
        );
      }
      validatePassword(password, confirmation);
    }
    let token = "";
    try {
      database.exec("BEGIN IMMEDIATE");
      const policy = this.dependencies.runtimePolicy();
      if (policy && !policy.registrationEnabled()) {
        throw new AuthValidationError("registration is closed");
      }
      if (!policy) {
        const setting = database
          .prepare(
            "SELECT value FROM store_settings WHERE key = 'auth_allow_registration'",
          )
          .get() as { value?: string } | undefined;
        if (setting?.value === "false") {
          throw new AuthValidationError("registration is closed");
        }
      }
      const requiredDomain = registrationDomain(database);
      if (requiredDomain && !normalized.endsWith(`@${requiredDomain}`)) {
        throw new AuthValidationError(
          `email must belong to ${requiredDomain}`,
        );
      }
      const existing = database
        .prepare("SELECT id FROM users WHERE email = ? OR username = ?")
        .get(normalized, username);
      if (existing) {
        database.exec("COMMIT");
        return { email: normalized };
      }
      token = crypto.randomBytes(32).toString("base64url");
      database
        .prepare(
          "UPDATE registration_tokens SET used_at = datetime('now') " +
            "WHERE email = ? AND used_at IS NULL",
        )
        .run(normalized);
      database
        .prepare(
          "INSERT INTO registration_tokens(email, username, password_hash, " +
            "token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+24 hours'))",
        )
        .run(
          normalized,
          username,
          password ? generateWerkzeugScryptHash(password) : null,
          hashApiToken(token),
        );
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }
    const email = this.dependencies.email();
    if (!email) {
      throw new AuthValidationError(
        "registration email delivery is unavailable",
      );
    }
    try {
      await email.sendRegistration(normalized, token);
    } catch (error) {
      try {
        database
          .prepare(
            "UPDATE registration_tokens SET used_at = datetime('now') " +
              "WHERE token_hash = ? AND used_at IS NULL",
          )
          .run(hashApiToken(token));
      } catch {
        // Diagnostics stay server-side; preserve the delivery error contract.
      }
      if (error instanceof EmailDeliveryError) throw error;
      throw new EmailDeliveryError();
    }
    return { email: normalized };
  }

  /** Consumes a registration token and creates the local user account. */
  completeRegistration(payload: Record<string, unknown>): Principal {
    const database = this.dependencies.writableDatabase();
    ensureAuthWorkflowSchema(database);
    const token = authScalar(payload.token);
    const password = authScalar(payload.password);
    const confirmation = authScalar(payload.password_confirm, password);
    try {
      database.exec("BEGIN IMMEDIATE");
      const record = database
        .prepare(
          "SELECT id, email, username, password_hash FROM registration_tokens " +
            "WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')",
        )
        .get(hashApiToken(token)) as {
        id: number;
        email: string;
        username: string | null;
        password_hash: string | null;
      } | undefined;
      if (!record) {
        throw new AuthValidationError(
          "registration link is invalid or expired",
        );
      }
      if (!record.password_hash) validatePassword(password, confirmation);
      const existing = database
        .prepare("SELECT id FROM users WHERE email = ? OR username = ?")
        .get(record.email, record.username ?? record.email);
      if (existing) {
        database
          .prepare(
            "UPDATE registration_tokens SET used_at = datetime('now') " +
              "WHERE id = ? AND used_at IS NULL",
          )
          .run(record.id);
        database.exec("COMMIT");
        throw new AuthValidationError("account already exists");
      }
      const finalPasswordHash =
        record.password_hash ?? generateWerkzeugScryptHash(password);
      const finalUsername = record.username?.trim() || record.email;
      const result = database
        .prepare(
          "INSERT INTO users(username, email, password_hash, role) " +
            "VALUES (?, ?, ?, 'user')",
        )
        .run(finalUsername, record.email, finalPasswordHash);
      const consumed = database
        .prepare(
          "UPDATE registration_tokens SET used_at = datetime('now') " +
            "WHERE id = ? AND used_at IS NULL AND expires_at > datetime('now')",
        )
        .run(record.id).changes;
      if (consumed !== 1) {
        throw new AuthValidationError(
          "registration link is invalid or expired",
        );
      }
      database.exec("COMMIT");
      return loadPrincipalById(
        database,
        Number(result.lastInsertRowid),
        "session",
      );
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }
}
