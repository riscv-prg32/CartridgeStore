import { normalizeRole, type Role } from "../auth/principal.js";
import type { GroupView } from "./service-contracts.js";
import { AdminError } from "./errors.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const GROUP_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_GROUP_IDS = 50;

/** Parses a positive administrative identifier. */
export function positiveAdminId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new AdminError(
      "invalid_identifier",
      400,
      `${label} is invalid`
    );
  }
  return Number(value);
}

/** Normalizes a local username according to the administrative contract. */
export function normalizeAdminUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim() : "";
  if (!USERNAME_RE.test(username)) {
    throw new AdminError("invalid_username", 400, "username is invalid");
  }
  return username;
}

/** Normalizes and validates an administrative email address. */
export function normalizeAdminEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new AdminError("invalid_email", 400, "email is invalid");
  }
  return email;
}

/** Normalizes an administrative role value. */
export function normalizeAdminRole(value: unknown): Role {
  if (typeof value !== "string") {
    throw new AdminError("invalid_role", 400, "role is invalid");
  }
  try {
    return normalizeRole(value);
  } catch {
    throw new AdminError("invalid_role", 400, "role is invalid");
  }
}

/** Normalizes a bounded, duplicate-free group identifier list. */
export function normalizeAdminGroupIds(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_GROUP_IDS) {
    throw new AdminError("invalid_group_ids", 400, "group_ids is invalid");
  }
  const ids = value.map((item) => positiveAdminId(item, "group id"));
  if (new Set(ids).size !== ids.length) {
    throw new AdminError(
      "duplicate_group_ids",
      400,
      "group_ids contains duplicates"
    );
  }
  return ids;
}

/** Normalizes a group name. */
export function normalizeAdminGroupName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!GROUP_RE.test(name)) {
    throw new AdminError(
      "invalid_group_name",
      400,
      "group name is invalid"
    );
  }
  return name;
}

/** Extracts a SQLite error code without coupling callers to the driver type. */
export function sqliteErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Decodes the bounded group projection stored in an administrative row. */
export function parseAdminGroups(value: unknown): GroupView[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is GroupView => {
        if (item === null || typeof item !== "object") return false;
        const row = item as Record<string, unknown>;
        return Number.isSafeInteger(row.id) && typeof row.name === "string";
      })
      .map((item) => ({
        id: Number(item.id),
        name: item.name,
        created_at: typeof item.created_at === "string"
          ? item.created_at
          : "",
        user_count: 0,
      }));
  } catch {
    return [];
  }
}

/** Decodes an audit summary while discarding malformed persisted values. */
export function parseAdminAuditSummary(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
