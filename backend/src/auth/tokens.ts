import crypto from "node:crypto";

import type Database from "better-sqlite3";

import { hasAccountStateColumn, hasAccountStatusColumn } from "./account-state.js";

export interface TokenOwner {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly groups: readonly string[];
}

export interface ApiTokenLookup {
  readonly tokenHash: string;
  readonly owner: TokenOwner;
  readonly label: string | null;
  readonly createdAt: string;
  readonly lastUsed: string | null;
}

export interface LegacyConfiguredUser {
  readonly name: string;
  readonly role: string;
  readonly token: string;
}

export function hashApiToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function lookupApiToken(sqlite: Database.Database, token: string): ApiTokenLookup | null {
  const tokenHash = hashApiToken(token);
  const columns = new Set((sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((item) => item.name));
  const displayName = columns.has("display_name") ? ", users.display_name" : "";
  const disabledColumn = hasAccountStateColumn(sqlite) ? ", users.disabled_at" : "";
  const statusColumn = hasAccountStatusColumn(sqlite) ? ", users.account_status" : "";
  const row = sqlite.prepare(
    "SELECT api_tokens.token_hash, api_tokens.label, api_tokens.created_at, api_tokens.last_used," +
    " users.id, users.username" + displayName + ", users.email, users.role" + disabledColumn + statusColumn +
    " FROM api_tokens JOIN users ON users.id = api_tokens.user_id" +
    " WHERE api_tokens.token_hash = ?"
  ).get(tokenHash) as
    | {
        token_hash: string;
        label: string | null;
        created_at: string;
        last_used: string | null;
        id: number;
        username: string;
        display_name?: string | null;
        email: string;
        role: string;
        disabled_at?: string | null;
        account_status?: string | null;
      }
    | undefined;
  if (!row || (row.disabled_at !== undefined && row.disabled_at !== null) || row.account_status === "suspended" || row.account_status === "banned" || row.account_status === "disabled") return null;
  const groups = sqlite
    .prepare(
      "SELECT groups.name FROM user_groups " +
      "JOIN groups ON groups.id = user_groups.group_id " +
      "WHERE user_groups.user_id = ? ORDER BY groups.name"
    )
    .all(row.id) as Array<{ name: string }>;
  return {
    tokenHash: row.token_hash,
    owner: {
      id: row.id,
      username: row.username,
      displayName: row.display_name?.trim() || row.username,
      email: row.email,
      role: row.role,
      groups: groups.map((group) => group.name)
    },
    label: row.label,
    createdAt: row.created_at,
    lastUsed: row.last_used
  };
}

function normalizeRole(value: unknown): string {
  const role = scalarString(value, "").trim().toLowerCase();
  if (!["reader", "user", "player", "publisher", "admin"].includes(role)) {
    throw new Error("unsupported configured role: " + role);
  }
  return role;
}

function scalarString(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
}

export function parseLegacyConfiguredUsers(raw: unknown): LegacyConfiguredUser[] {
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null).map((item) => ({
      name: scalarString(item.name ?? item.user ?? item.role, "user").trim() || "user",
      role: normalizeRole(item.role ?? "reader"),
      token: scalarString(item.token, "").trim()
    }));
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([token, value]) => {
      if (typeof value === "object" && value !== null) {
        const item = value as Record<string, unknown>;
        return {
          name: scalarString(item.name ?? item.user ?? item.role, "user").trim() || "user",
          role: normalizeRole(item.role ?? "reader"),
          token: scalarString(item.token, token).trim() || token
        };
      }
      return { name: scalarString(value, "user").trim() || "user", role: normalizeRole(value), token };
    });
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith("[") || text.startsWith("{")) {
      return parseLegacyConfiguredUsers(JSON.parse(text));
    }
    return text.split(",").filter(Boolean).map((chunk) => {
      const firstSeparator = chunk.indexOf(":");
      const secondSeparator = firstSeparator < 0 ? -1 : chunk.indexOf(":", firstSeparator + 1);
      if (firstSeparator < 0 || secondSeparator < 0) throw new Error("PRG32_USERS entries must be name:role:token");
      const name = chunk.slice(0, firstSeparator).trim();
      const role = chunk.slice(firstSeparator + 1, secondSeparator).trim();
      const token = chunk.slice(secondSeparator + 1).trim();
      return { name: name || role || "user", role: normalizeRole(role), token };
    });
  }
  throw new Error("legacy user configuration must be a JSON array or object");
}

export function lookupLegacyConfiguredUser(users: readonly LegacyConfiguredUser[], token: string): LegacyConfiguredUser | null {
  return users.find((user) => user.token === token) ?? null;
}
