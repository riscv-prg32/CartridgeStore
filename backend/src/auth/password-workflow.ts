import crypto from "node:crypto";

import { EmailDeliveryError } from "../email/service.js";
import { AuthValidationError } from "./errors.js";
import { generateWerkzeugScryptHash } from "./password-hash.js";
import { verifyWerkzeugPasswordHash } from "./password.js";
import { ensureAuthWorkflowSchema } from "./workflow-schema.js";
import type { AuthWorkflowDependencies } from "./workflow-context.js";
import { hashApiToken } from "./tokens.js";
import { validatePassword } from "./validation.js";

/** Handles local password changes and one-time password recovery. */
export class PasswordWorkflow {
  constructor(private readonly dependencies: AuthWorkflowDependencies) {}

  /** Changes a local account password after validating the current password. */
  changePassword(
    userId: number,
    currentPassword: string,
    password: string,
    confirmation: string,
  ): void {
    validatePassword(password, confirmation);
    const database = this.dependencies.writableDatabase();
    const row = database
      .prepare(
        "SELECT password_hash, external_provider, email FROM users " +
          "WHERE id = ? AND disabled_at IS NULL",
      )
      .get(userId) as {
      password_hash: string | null;
      external_provider: string | null;
      email: string;
    } | undefined;
    if (!row?.password_hash || row.external_provider) {
      throw new AuthValidationError(
        "local password management is unavailable for this account",
      );
    }
    if (
      verifyWerkzeugPasswordHash(row.password_hash, currentPassword).status !==
      "valid"
    ) {
      throw new AuthValidationError("current password is incorrect");
    }
    database
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(generateWerkzeugScryptHash(password), userId);
    database
      .prepare(
        "UPDATE password_reset_tokens SET used_at = datetime('now') " +
          "WHERE user_id = ? AND used_at IS NULL",
      )
      .run(userId);
    this.dependencies.sessions()?.invalidateUser(userId);
  }

  /** Creates a password reset token and sends its email when applicable. */
  async requestPasswordReset(identifier: string): Promise<void> {
    const database = this.dependencies.writableDatabase();
    ensureAuthWorkflowSchema(database);
    const normalized = identifier.trim();
    if (!normalized) return;
    const row = database
      .prepare(
        "SELECT id, email, password_hash, external_provider, disabled_at " +
          "FROM users WHERE lower(email) = lower(?) OR username = ? LIMIT 1",
      )
      .get(normalized, normalized) as {
      id: number;
      email: string;
      password_hash: string | null;
      external_provider: string | null;
      disabled_at: string | null;
    } | undefined;
    if (!row || row.disabled_at !== null || !row.password_hash || row.external_provider) {
      return;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          "UPDATE password_reset_tokens SET used_at = datetime('now') " +
            "WHERE user_id = ? AND used_at IS NULL",
        )
        .run(row.id);
      database
        .prepare(
          "INSERT INTO password_reset_tokens(user_id, token_hash, expires_at) " +
            "VALUES (?, ?, datetime('now', '+1 hour'))",
        )
        .run(row.id, hashApiToken(token));
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }
    const email = this.dependencies.email();
    if (!email) throw new EmailDeliveryError();
    try {
      await email.sendPasswordReset(row.email, token);
    } catch (error) {
      database
        .prepare(
          "UPDATE password_reset_tokens SET used_at = datetime('now') " +
            "WHERE token_hash = ? AND used_at IS NULL",
        )
        .run(hashApiToken(token));
      if (error instanceof EmailDeliveryError) throw error;
      throw new EmailDeliveryError();
    }
  }

  /** Consumes a password reset token and invalidates existing sessions. */
  completePasswordReset(
    token: string,
    password: string,
    confirmation: string,
  ): void {
    validatePassword(password, confirmation);
    const database = this.dependencies.writableDatabase();
    ensureAuthWorkflowSchema(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database
        .prepare(
          "SELECT id, user_id FROM password_reset_tokens WHERE token_hash = ? " +
            "AND used_at IS NULL AND expires_at > datetime('now')",
        )
        .get(hashApiToken(token)) as {
        id: number;
        user_id: number;
      } | undefined;
      if (!row) {
        throw new AuthValidationError(
          "password reset link is invalid or expired",
        );
      }
      const user = database
        .prepare(
          "SELECT password_hash, external_provider, disabled_at FROM users " +
            "WHERE id = ?",
        )
        .get(row.user_id) as {
        password_hash: string | null;
        external_provider: string | null;
        disabled_at: string | null;
      } | undefined;
      if (!user?.password_hash || user.external_provider || user.disabled_at !== null) {
        throw new AuthValidationError(
          "password reset link is invalid or expired",
        );
      }
      database
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(generateWerkzeugScryptHash(password), row.user_id);
      const consumed = database
        .prepare(
          "UPDATE password_reset_tokens SET used_at = datetime('now') " +
            "WHERE id = ? AND used_at IS NULL",
        )
        .run(row.id).changes;
      if (consumed !== 1) {
        throw new AuthValidationError(
          "password reset link is invalid or expired",
        );
      }
      database
        .prepare(
          "UPDATE password_reset_tokens SET used_at = datetime('now') " +
            "WHERE user_id = ? AND used_at IS NULL",
        )
        .run(row.user_id);
      this.dependencies.sessions()?.invalidateUser(row.user_id);
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }
}
