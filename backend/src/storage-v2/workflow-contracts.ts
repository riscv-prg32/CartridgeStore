import type { BackendConfig } from "../config/env.js";
import type { RuntimePolicy } from "../settings/runtime-policy.js";
import type { StorageDatabase } from "./types.js";
import type { ApprovalNotifier } from "../email/notifications.js";

/** Fault injection points for canonical workflow recovery tests. */
export type CanonicalWorkflowFaultPoint =
  | "before-durable-intent"
  | "after-durable-intent"
  | "before-object-promotion"
  | "after-object-promotion"
  | "before-visibility"
  | "after-visibility"
  | "before-completion"
  | "during-staging-cleanup";

/** Dependencies and policy for the canonical workflow service. */
export interface CanonicalWorkflowOptions {
  readonly config: BackendConfig;
  readonly root: string;
  readonly database: StorageDatabase;
  readonly fault?: (point: CanonicalWorkflowFaultPoint) => void;
  readonly policy?: RuntimePolicy;
  readonly approvalNotifier?: ApprovalNotifier;
}

/** Event data recorded when a published cartridge is downloaded. */
export interface CanonicalDownloadEvent {
  readonly gameId: string;
  readonly version: string;
  readonly architecture: "esp32c6" | "qemu";
  readonly userId: number | null;
  readonly ipAddress: string | null;
  readonly userAgent: string;
}
