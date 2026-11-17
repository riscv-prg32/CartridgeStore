import { requestApiJson, withCsrfToken } from "../client";
import {
  setupAuthorizedResponseSchema,
  setupCompleteResponseSchema,
  setupProgressResponseSchema,
  setupStatusResponseSchema,
} from "../schemas";
import type { SetupProgress, SetupStatus, SetupStep } from "./types";

/** Reads the installation status and infrastructure readiness. */
export function getSetupStatus(): Promise<SetupStatus> {
  return requestApiJson(
    "/api/setup/status",
    undefined,
    setupStatusResponseSchema,
  );
}

/** Authorizes the setup flow with the bootstrap token. */
export function authorizeSetup(bootstrapToken: string) {
  return requestApiJson(
    "/api/setup/authorize",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bootstrap_token: bootstrapToken }),
    },
    setupAuthorizedResponseSchema,
  );
}

/** Reads the current setup progress. */
export function getSetupProgress(): Promise<SetupProgress> {
  return requestApiJson(
    "/api/setup/progress",
    undefined,
    setupProgressResponseSchema,
  );
}

/** Saves one setup step using the existing CSRF-protected contract. */
export function saveSetupStep(
  csrfToken: string,
  step: SetupStep,
  payload: Record<string, unknown>,
): Promise<SetupProgress> {
  return requestApiJson(
    "/api/setup/progress",
    {
      method: "POST",
      headers: withCsrfToken(csrfToken, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ step, payload }),
    },
    setupProgressResponseSchema,
  );
}

/** Completes installation and returns the canonical redirect. */
export function completeSetup(csrfToken: string) {
  return requestApiJson(
    "/api/setup/complete",
    {
      method: "POST",
      headers: withCsrfToken(csrfToken),
      body: "{}",
    },
    setupCompleteResponseSchema,
  );
}
