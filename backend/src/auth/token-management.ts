import crypto from "node:crypto";

import type Database from "better-sqlite3";

import { AuthValidationError } from "./errors.js";
import { hashApiToken } from "./tokens.js";

/** Lists the public metadata for tokens owned by one user. */
export function listUserTokens(
  database: Database.Database,
  userId: number,
): Array<Record<string, unknown>> {
  return (
    database
      .prepare(
        "SELECT id, label, created_at, last_used FROM api_tokens " +
          "WHERE user_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(userId) as Array<{
      id: number;
      label: string | null;
      created_at: string;
      last_used: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    label: row.label || "API token",
    created_at: row.created_at,
    last_used: row.last_used || "",
  }));
}

/** Creates one API token and returns its one-time cleartext value. */
export function createUserToken(
  database: Database.Database,
  userId: number,
  label: string,
): Record<string, unknown> {
  const token = `prg32_${crypto.randomBytes(32).toString("base64url")}`;
  const normalizedLabel = (label.trim() || "API token").slice(0, 80);
  const result = database
    .prepare(
      "INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)",
    )
    .run(userId, hashApiToken(token), normalizedLabel);
  return {
    ok: true,
    id: Number(result.lastInsertRowid),
    label: normalizedLabel,
    token,
  };
}

/** Updates a token label when the token belongs to the requesting user. */
export function updateUserToken(
  database: Database.Database,
  userId: number,
  tokenId: number,
  label: string,
): boolean {
  const normalized = label.trim().slice(0, 80);
  if (!normalized) throw new AuthValidationError("label is required");
  return (
    database
      .prepare(
        "UPDATE api_tokens SET label = ? WHERE id = ? AND user_id = ?",
      )
      .run(normalized, tokenId, userId).changes > 0
  );
}

/** Revokes a token when it belongs to the requesting user. */
export function revokeUserToken(
  database: Database.Database,
  userId: number,
  tokenId: number,
): boolean {
  return (
    database
      .prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
      .run(tokenId, userId).changes > 0
  );
}
