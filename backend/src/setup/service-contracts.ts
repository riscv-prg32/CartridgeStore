import type Database from "better-sqlite3";

import type { AdminAuditLog } from "../admin/audit.js";
import type { AuthService } from "../auth/service.js";
import type { BackendConfig } from "../config/env.js";
import type { FederationProviderOperations } from "../federation/operations.js";
import type {
  FederationProviderService,
} from "../federation/provider.js";
import type { SettingsService } from "../settings/service.js";

/** Durable states of the first-installation workflow. */
export const SETUP_STATES = [
  "INFRASTRUCTURE_NOT_READY",
  "INSTALLATION_REQUIRED",
  "INSTALLATION_IN_PROGRESS",
  "INSTALLATION_COMPLETE",
  "INSTALLATION_RECOVERY_REQUIRED",
] as const;

/** First-installation state persisted in canonical SQLite. */
export type SetupState = typeof SETUP_STATES[number];

/** Ordered setup steps exposed by the installation workflow. */
export const SETUP_STEPS = [
  "admin",
  "store",
  "registration",
  "security",
  "smtp",
  "oidc",
  "saml",
  "mdns",
  "review",
] as const;

/** A setup step identifier. */
export type SetupStep = typeof SETUP_STEPS[number];

/** In-memory setup authorization session. */
export interface SetupSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

/** Dependencies required by the setup service. */
export interface SetupServiceOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly settings: SettingsService;
  readonly providers: FederationProviderService | null;
  readonly operations: FederationProviderOperations | null;
  readonly audit?: AdminAuditLog;
  readonly database: Database.Database | null;
}
