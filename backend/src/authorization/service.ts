import type { Principal } from "../auth/principal.js";
import { canAccessResource, canAdministerCatalog, evaluatePermission, hasPermission, type AuthorizationDecision, type OwnedResource } from "./policies.js";
import type { Permission } from "./permissions.js";

export class AuthorizationError extends Error {
  readonly code = "permission_denied";
  readonly statusCode = 403;

  constructor() {
    super("permission denied");
    this.name = "AuthorizationError";
  }
}

/** Stateless authorization facade shared by Fastify routes and services. */
export class AuthorizationService {
  decide(principal: unknown, permission: unknown): AuthorizationDecision {
    return evaluatePermission(principal, permission);
  }

  hasPermission(principal: unknown, permission: unknown): boolean {
    return hasPermission(principal, permission);
  }

  requirePermission(principal: unknown, permission: Permission): void {
    if (!this.hasPermission(principal, permission)) throw new AuthorizationError();
  }

  canAccessResource(principal: unknown, permission: Permission, resource: OwnedResource): boolean {
    return canAccessResource(principal, permission, resource);
  }

  canAdministerCatalog(principal: Principal): boolean {
    return canAdministerCatalog(principal);
  }
}
