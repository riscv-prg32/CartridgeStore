import type { Principal } from "../auth/principal.js";
import type { Permission } from "./permissions.js";
import type { AuthorizationService } from "./service.js";

/** Route-level adapter: request security remains outside this permission guard. */
export function permissionGuard(authorization: AuthorizationService, principal: Principal, permission: Permission): boolean {
  return authorization.hasPermission(principal, permission);
}
