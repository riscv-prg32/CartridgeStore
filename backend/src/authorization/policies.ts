import type { Principal } from "../auth/principal.js";
import { CATALOG_ADMIN_POLICY, GROUP_PERMISSIONS, isPermission, isRole, ROLE_PERMISSIONS, type Permission } from "./permissions.js";

export interface OwnedResource {
  readonly ownerId: number | null | undefined;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: "allowed" | "anonymous" | "malformed_principal" | "unknown_permission" | "missing_permission" | "invalid_resource";
}

function isPrincipal(value: unknown): value is Principal {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Principal>;
  return candidate.authenticated === true
    && Number.isSafeInteger(candidate.id) && (candidate.id ?? 0) > 0
    && typeof candidate.role === "string" && isRole(candidate.role)
    && Array.isArray(candidate.groups) && candidate.groups.every((group) => typeof group === "string")
    && typeof candidate.name === "string"
    && typeof candidate.username === "string"
    && typeof candidate.email === "string";
}

function normalizedGroups(principal: Principal): Set<string> {
  // Preserve the existing principal/group contract: persisted group names
  // are compared to canonical names exactly; unknown/case-variant groups do
  // not gain capabilities through implicit normalization.
  return new Set(principal.groups.filter((group): group is string => typeof group === "string"));
}

function permissionSetFor(principal: Principal): Set<Permission> {
  const permissions = new Set<Permission>(ROLE_PERMISSIONS[principal.role]);
  for (const group of normalizedGroups(principal)) {
    for (const permission of GROUP_PERMISSIONS[group] ?? []) permissions.add(permission);
  }
  return permissions;
}

export function evaluatePermission(principal: unknown, permission: unknown): AuthorizationDecision {
  if (!isPermission(permission)) return { allowed: false, reason: "unknown_permission" };
  if (!isPrincipal(principal)) return { allowed: false, reason: "malformed_principal" };
  if (!permissionSetFor(principal).has(permission)) return { allowed: false, reason: "missing_permission" };
  return { allowed: true, reason: "allowed" };
}

export function hasPermission(principal: unknown, permission: unknown): boolean {
  return evaluatePermission(principal, permission).allowed;
}

export function canAccessResource(principal: unknown, permission: unknown, resource: OwnedResource): boolean {
  if (!resource || !Number.isSafeInteger(resource.ownerId) || (resource.ownerId ?? 0) <= 0) {
    return isPermission(permission) && permission.endsWith(":any") && hasPermission(principal, permission);
  }
  if (isPermission(permission) && permission.endsWith(":self")) {
    return hasPermission(principal, permission)
      && isPrincipal(principal)
      && principal.id === resource.ownerId;
  }
  return hasPermission(principal, permission);
}

export function canAdministerCatalog(principal: unknown): boolean {
  if (!isPrincipal(principal)) return false;
  const groups = normalizedGroups(principal);
  return CATALOG_ADMIN_POLICY.roles.includes(principal.role as typeof CATALOG_ADMIN_POLICY.roles[number])
    || CATALOG_ADMIN_POLICY.groups.some((group) => groups.has(group));
}
