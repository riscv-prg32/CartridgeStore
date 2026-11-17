import { adminRequest } from "./transport";
import type { AdminPrincipalResponse } from "./types";

/** Reads the authenticated administrator principal. */
export function getAdminPrincipal(): Promise<AdminPrincipalResponse> {
  return adminRequest("/auth/me");
}
