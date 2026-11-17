import type { BackendConfig } from "../config/env.js";

/**
 * Keep protocol callbacks on the API host, then return the browser to the
 * explicitly configured frontend origin in dual-origin mode. The path has
 * already passed the federation transaction safe-return validation.
 */
export function browserReturnLocation(config: BackendConfig, returnPath: string): string {
  if (!config.frontendPublicOrigin) return returnPath;
  return new URL(returnPath, config.frontendPublicOrigin).toString();
}
