import { describe, expect, it } from "vitest";

import { ANONYMOUS, type Principal, type Role } from "../src/auth/principal.js";
import { AuthorizationError, AuthorizationService } from "../src/authorization/service.js";
import { GROUP_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS } from "../src/authorization/permissions.js";
import { canAccessResource, canAdministerCatalog, hasPermission } from "../src/authorization/policies.js";

function principal(role: Role, groups: readonly string[] = [], id = 7): Principal {
  return {
    authenticated: true,
    id,
    name: `user-${id}`,
    username: `user-${id}`,
    email: `user-${id}@example.test`,
    role,
    groups,
    authMethod: "session"
  };
}

describe("centralized authorization policy", () => {
  it("has a unique typed registry and an explicit mapping for every persisted role", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const role of ["reader", "user", "player", "publisher", "admin"] as const) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
      expect(new Set(ROLE_PERMISSIONS[role]).size).toBe(ROLE_PERMISSIONS[role].length);
    }
    expect(GROUP_PERMISSIONS.editors).toEqual(expect.arrayContaining(["submissions:read", "submissions:review", "submissions:reject"]));
  });

  it("fails closed for anonymous, unknown, and malformed principals", () => {
    expect(hasPermission(ANONYMOUS, "users:delete")).toBe(false);
    expect(hasPermission(principal("user", ["unknown-admins"]), "users:delete")).toBe(false);
    expect(hasPermission(principal("user", ["EDITORS"]), "submissions:review")).toBe(false);
    expect(hasPermission({ authenticated: true, role: "admin", groups: ["editors"] }, "users:delete")).toBe(false);
    expect(hasPermission(principal("admin"), "not-a-real-permission")).toBe(false);
    expect(hasPermission(principal("user"), "backup:restore")).toBe(false);
    expect(hasPermission(principal("publisher"), "submissions:review")).toBe(false);
    expect(hasPermission(principal("admin"), "tokens:read:any")).toBe(true);
    expect(hasPermission(principal("user", ["editors"]), "tokens:read:any")).toBe(false);
    expect(hasPermission(principal("publisher"), "tokens:revoke:any")).toBe(false);
  });

  it("keeps review group-only while preserving admin-or-editors catalog administration", () => {
    const admin = principal("admin");
    const editor = principal("user", ["editors"]);
    const adminEditor = principal("admin", ["editors"]);

    expect(hasPermission(admin, "submissions:review")).toBe(false);
    expect(hasPermission(editor, "submissions:review")).toBe(true);
    expect(hasPermission(adminEditor, "submissions:review")).toBe(true);
    expect(canAdministerCatalog(admin)).toBe(true);
    expect(canAdministerCatalog(editor)).toBe(true);
    expect(canAdministerCatalog(principal("publisher"))).toBe(false);
  });

  it("enforces self ownership and permits nullable resources only through :any", () => {
    const owner = principal("user", [], 7);
    const other = principal("user", [], 8);
    const admin = principal("admin", [], 9);
    const authorization = new AuthorizationService();

    expect(canAccessResource(owner, "tokens:revoke:self", { ownerId: 7 })).toBe(true);
    expect(canAccessResource(other, "tokens:revoke:self", { ownerId: 7 })).toBe(false);
    expect(canAccessResource(admin, "tokens:revoke:self", { ownerId: 7 })).toBe(false);
    expect(canAccessResource(admin, "runs:read:any", { ownerId: 7 })).toBe(true);
    expect(canAccessResource(owner, "runs:read:self", { ownerId: null })).toBe(false);
    expect(canAccessResource(admin, "runs:read:any", { ownerId: null })).toBe(true);
    expect(canAccessResource(owner, "runs:read:self", { ownerId: 0 })).toBe(false);
    expect(authorization.decide(owner, "unknown").reason).toBe("unknown_permission");
  });

  it("exposes stable errors without principal details", () => {
    const authorization = new AuthorizationService();
    expect(() => authorization.requirePermission(principal("user"), "users:delete")).toThrow(AuthorizationError);
    try {
      authorization.requirePermission(principal("user"), "users:delete");
    } catch (error) {
      expect(error).toMatchObject({ code: "permission_denied", statusCode: 403, message: "permission denied" });
      expect(String(error)).not.toContain("user-7");
    }
  });
});
