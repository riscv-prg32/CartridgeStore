import type Database from "better-sqlite3";

import type { EmailService } from "../email/service.js";
import type { RuntimePolicy } from "../settings/runtime-policy.js";
import type { SessionStore } from "./session.js";

/** Runtime dependencies shared by account authentication workflows. */
export interface AuthWorkflowDependencies {
  readonly database: () => Database.Database;
  readonly writableDatabase: () => Database.Database;
  readonly email: () => EmailService | undefined;
  readonly runtimePolicy: () => RuntimePolicy | undefined;
  readonly sessions: () => SessionStore | null;
}
