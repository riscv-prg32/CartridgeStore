import type Database from "better-sqlite3";

import type { Principal } from "../auth/principal.js";
import { ReviewError } from "../review/errors.js";

/** Resolves a principal against the canonical user row for workflow writes. */
export function canonicalWorkflowPrincipal(
  database: Database.Database,
  principal: Principal,
  reviewer = false,
): { id: number; name: string } {
  if (
    !principal.authenticated ||
    principal.id === null ||
    !Number.isSafeInteger(principal.id) ||
    principal.id <= 0
  ) {
    throw new ReviewError(
      reviewer ? "reviewer authentication is required" : "login required",
      "review_not_authorized",
      401,
    );
  }

  const row = database
    .prepare(
      "SELECT username, role, disabled_at FROM users WHERE id = ?",
    )
    .get(principal.id) as
    | { username?: string; role?: string; disabled_at?: string | null }
    | undefined;

  if (!row || (row.disabled_at !== null && row.disabled_at !== undefined)) {
    throw new ReviewError(
      "canonical account is unavailable",
      "review_not_authorized",
      403,
    );
  }

  if (String(row.role).toLowerCase() !== principal.role) {
    throw new ReviewError(
      "canonical account authorization is stale",
      "review_not_authorized",
      403,
    );
  }

  return {
    id: principal.id,
    name: String(row.username ?? principal.name).trim(),
  };
}
