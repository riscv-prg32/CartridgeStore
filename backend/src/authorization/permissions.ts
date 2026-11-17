import type { Role } from "../auth/principal.js";

/**
 * Static permission identifiers. These are application capabilities, not
 * persisted roles and not database records.
 */
export const PERMISSIONS = [
  "settings:read",
  "settings:write",
  "settings:assets:write",
  "users:read",
  "users:create",
  "users:update",
  "users:delete",
  "users:roles:manage",
  "users:groups:manage",
  "groups:read",
  "groups:manage",
  "roles:read",
  "tokens:read:self",
  "tokens:create:self",
  "tokens:update:self",
  "tokens:revoke:self",
  "tokens:read:any",
  "tokens:revoke:any",
  "catalog:read",
  "catalog:submit",
  "catalog:publish",
  "catalog:metadata:write",
  "catalog:delete",
  "submissions:read",
  "submissions:review",
  "submissions:reject",
  "stats:read",
  "runs:read:self",
  "runs:read:any",
  "runs:export:self",
  "runs:export:any",
  "backup:export",
  "backup:restore",
  "federation:read",
  "federation:manage"
] as const;

export type Permission = typeof PERMISSIONS[number];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  "settings:read",
  "settings:write",
  "settings:assets:write",
  "users:read",
  "users:create",
  "users:update",
  "users:delete",
  "users:roles:manage",
  "users:groups:manage",
  "groups:read",
  "groups:manage",
  "roles:read",
  "tokens:read:any",
  "tokens:revoke:any",
  "catalog:metadata:write",
  "catalog:delete",
  "runs:read:any",
  "runs:export:any",
  "backup:export",
  "backup:restore",
  "federation:read",
  "federation:manage"
];

const AUTHENTICATED_PERMISSIONS: readonly Permission[] = [
  "catalog:read",
  "catalog:submit",
  "tokens:read:self",
  "tokens:create:self",
  "tokens:update:self",
  "tokens:revoke:self",
  "runs:read:self",
  "runs:export:self",
  "stats:read"
];

/** Explicit mapping from persisted role names to capabilities. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  reader: AUTHENTICATED_PERMISSIONS,
  user: AUTHENTICATED_PERMISSIONS,
  player: AUTHENTICATED_PERMISSIONS,
  publisher: AUTHENTICATED_PERMISSIONS,
  admin: [...AUTHENTICATED_PERMISSIONS, ...ADMIN_PERMISSIONS]
};

/** Explicit group-derived capabilities. Unknown groups grant nothing. */
export const GROUP_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  editors: [
    "catalog:publish",
    "catalog:metadata:write",
    "catalog:delete",
    "submissions:read",
    "submissions:review",
    "submissions:reject"
  ]
};

/** Catalog administration is deliberately separate from submission review. */
export const CATALOG_ADMIN_POLICY = {
  roles: ["admin"] as const,
  groups: ["editors"] as const
};

const permissionSet = new Set<string>(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && permissionSet.has(value);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && value in ROLE_PERMISSIONS;
}
