import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { AdminIdentityService } from "../src/admin/service.js";
import { AdminAuditLog } from "../src/admin/audit.js";

const roots: string[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];
const BOOTSTRAP = "admin-bootstrap-token-1234567890";

function createDatabase(): { readonly root: string; readonly databasePath: string; readonly storeRoot: string; readonly authRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m63d2c-"));
  roots.push(root);
  const storeRoot = path.join(root, "store");
  const authRoot = path.join(root, "auth-workspace");
  const databasePath = path.join(authRoot, "auth.sqlite");
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(authRoot);
  const db = new Database(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO groups(name) VALUES ('editors');
  `);
  db.close();
  fs.writeFileSync(path.join(storeRoot, "index.json"), JSON.stringify({ abi: "prg32-cartridge-store-index-1.0", games: {} }));
  return { root, databasePath, storeRoot, authRoot };
}

function fixture() {
  const paths = createDatabase();
  const shadow = path.join(paths.root, "shadow.sqlite");
  fs.writeFileSync(shadow, Buffer.from("shadow"));
  const config = loadConfig({
    PRG32_BACKEND_DB: shadow,
    PRG32_BACKEND_STORE_DATA: paths.storeRoot,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: paths.databasePath,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: paths.authRoot,
    PRG32_BACKEND_SESSION_SECRET: "admin-session-secret-1234567890-abcdef",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false"
  });
  const app = buildApp({ config, logger: false });
  apps.push(app);
  return { app, config, ...paths };
}

function header(response: { readonly headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function adminSession(app: ReturnType<typeof buildApp>): Promise<{ readonly cookie: string; readonly csrf: string; readonly userId: number }> {
  const bootstrap = await app.inject({
    method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP },
    payload: { username: "root-admin", email: "root-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" }
  });
  expect(bootstrap.statusCode).toBe(201);
  const cookie = header(bootstrap, "set-cookie").split(";", 1)[0] ?? "";
  const csrf = (await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } })).json<{ csrf_token: string }>().csrf_token;
  return { cookie, csrf, userId: bootstrap.json<{ user: { id: number } }>().user.id };
}

function responseCode(response: { json<T = unknown>(): T }): unknown { return response.json<Record<string, unknown>>().code; }
function addToken(databasePath: string, userId: number, token: string): void {
  const db = new Database(databasePath);
  db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(userId, hashApiToken(token), "test token");
  db.close();
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("user, role, and group administration", () => {
  it("enforces the admin API matrix and strict JSON fields", async () => {
    const test = fixture();
    expect((await test.app.inject({ method: "GET", url: "/api/admin/users" })).statusCode).toBe(401);
    const admin = await adminSession(test.app);
    const adminRead = await test.app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: admin.cookie } });
    expect(adminRead.statusCode).toBe(200);
    const db = new Database(test.databasePath);
    const ordinary = db.prepare("INSERT INTO users(username, email, role) VALUES (?, ?, 'user')").run("ordinary-user", "ordinary@example.test");
    db.close();
    const ordinaryToken = "prg32-ordinary-admin-route-token";
    addToken(test.databasePath, Number(ordinary.lastInsertRowid), ordinaryToken);
    const ordinaryDenied = await test.app.inject({ method: "GET", url: "/api/admin/users", headers: { authorization: `Bearer ${ordinaryToken}` } });
    expect(ordinaryDenied.statusCode).toBe(403);

    const created = await test.app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf },
      payload: { username: "managed-user", email: "managed@example.test", password: "managed-password-123", password_confirm: "managed-password-123", role: "user", group_ids: [] }
    });
    expect(created.statusCode).toBe(201);
    const managedId = created.json<{ user: { id: number; role: string; groups: unknown[] } }>().user.id;
    expect(created.json<{ user: { role: string; groups: unknown[] } }>().user).toMatchObject({ role: "user", groups: [] });
    expect(created.body).not.toContain("password");
    expect(created.body).not.toContain("token_hash");

    const duplicate = await test.app.inject({
      method: "POST", url: "/api/admin/users", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf },
      payload: { username: "managed-user", email: "other@example.test", password: "managed-password-123" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(responseCode(duplicate)).toBe("identity_conflict");

    const unknown = await test.app.inject({
      method: "PATCH", url: `/api/admin/users/${managedId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf },
      payload: { role: "admin" }
    });
    expect(unknown.statusCode).toBe(400);
    expect(responseCode(unknown)).toBe("unknown_field");

    const invalidRole = await test.app.inject({
      method: "PATCH", url: `/api/admin/users/${managedId}/role`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { role: "superadmin" }
    });
    expect(invalidRole.statusCode).toBe(400);
    expect(responseCode(invalidRole)).toBe("invalid_role");

    const bearerMutation = await test.app.inject({ method: "DELETE", url: `/api/admin/users/${managedId}`, headers: { authorization: "Bearer invalid" } });
    expect(bearerMutation.statusCode).toBe(401);
    const noCsrf = await test.app.inject({ method: "POST", url: "/api/admin/groups", headers: { cookie: admin.cookie }, payload: { name: "moderators" } });
    expect(noCsrf.statusCode).toBe(403);

    expect((await test.app.inject({ method: "GET", url: "/api/admin/roles", headers: { cookie: admin.cookie } })).json<{ roles: unknown[] }>().roles).toHaveLength(5);
    expect((await test.app.inject({ method: "POST", url: "/api/admin/roles", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: {} })).statusCode).toBe(404);

    const disableRegistration = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { auth_allow_registration: false } });
    expect(disableRegistration.statusCode).toBe(200);
    const registrationCsrf = await test.app.inject({ method: "GET", url: "/auth/csrf" });
    const registrationCookie = header(registrationCsrf, "set-cookie").split(";", 1)[0] ?? "";
    const disabledRegistration = await test.app.inject({ method: "POST", url: "/auth/register", headers: { cookie: registrationCookie, "x-csrftoken": registrationCsrf.json<{ csrf_token: string }>().csrf_token }, payload: { email: "disabled@example.test" } });
    expect(disabledRegistration.statusCode).toBe(400);
    const enableRegistration = await test.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { auth_allow_registration: true } });
    expect(enableRegistration.statusCode).toBe(200);
  });

  it("supports group CRUD, protected editors membership, and immediate authorization changes", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const group = await test.app.inject({ method: "POST", url: "/api/admin/groups", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { name: "moderators" } });
    expect(group.statusCode).toBe(201);
    const groupId = group.json<{ group: { id: number } }>().group.id;
    const duplicate = await test.app.inject({ method: "POST", url: "/api/admin/groups", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { name: "moderators" } });
    expect(duplicate.statusCode).toBe(409);
    const renamed = await test.app.inject({ method: "PATCH", url: `/api/admin/groups/${groupId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { name: "reviewers" } });
    expect(renamed.statusCode).toBe(200);

    const editorsId = (await test.app.inject({ method: "GET", url: "/api/admin/groups", headers: { cookie: admin.cookie } })).json<{ groups: Array<{ id: number; name: string }> }>().groups.find((item) => item.name === "editors")?.id;
    expect(editorsId).toBeTypeOf("number");
    const protectedRename = await test.app.inject({ method: "PATCH", url: `/api/admin/groups/${editorsId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { name: "not-editors" } });
    expect(protectedRename.statusCode).toBe(409);
    expect(responseCode(protectedRename)).toBe("protected_group");
    const protectedDelete = await test.app.inject({ method: "DELETE", url: `/api/admin/groups/${editorsId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } });
    expect(protectedDelete.statusCode).toBe(409);

    const created = await test.app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { username: "editor-user", email: "editor@example.test", password: "editor-password-123", group_ids: [groupId] } });
    const userId = created.json<{ user: { id: number } }>().user.id;
    const unknownGroup = await test.app.inject({ method: "PUT", url: `/api/admin/users/${userId}/groups`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { group_ids: [9999] } });
    expect(unknownGroup.statusCode).toBe(404);
    const duplicateGroup = await test.app.inject({ method: "PUT", url: `/api/admin/users/${userId}/groups`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { group_ids: [groupId, groupId] } });
    expect(duplicateGroup.statusCode).toBe(400);
    const withEditors = await test.app.inject({ method: "PUT", url: `/api/admin/users/${userId}/groups`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { group_ids: [Number(editorsId)] } });
    expect(withEditors.statusCode).toBe(200);
    expect(withEditors.body).toContain("editors");

    const renamedDelete = await test.app.inject({ method: "DELETE", url: `/api/admin/groups/${groupId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } });
    expect(renamedDelete.statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/api/admin/groups", headers: { cookie: admin.cookie } })).body).not.toContain("reviewers");
  });

  it("invalidates sessions and tokens for password, role, groups, and deletion", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const created = await test.app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { username: "credential-user", email: "credential@example.test", password: "credential-password-123" } });
    const userId = created.json<{ user: { id: number } }>().user.id;
    const anonymousCsrf = await test.app.inject({ method: "GET", url: "/auth/csrf" });
    const anonymousCookie = header(anonymousCsrf, "set-cookie").split(";", 1)[0] ?? "";
    const userLogin = await test.app.inject({ method: "POST", url: "/auth/login", headers: { cookie: anonymousCookie, "x-csrftoken": anonymousCsrf.json<{ csrf_token: string }>().csrf_token }, payload: { username: "credential-user", password: "credential-password-123" } });
    const oldSession = header(userLogin, "set-cookie").split(";", 1)[0] ?? "";
    const token = "prg32-password-old-token";
    addToken(test.databasePath, userId, token);
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { cookie: oldSession } })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

    const passwordChange = await test.app.inject({ method: "PATCH", url: `/api/admin/users/${userId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { password: "new-credential-password-123" } });
    expect(passwordChange.statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { cookie: oldSession } })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);

    const freshToken = "prg32-role-old-token";
    addToken(test.databasePath, userId, freshToken);
    const roleChange = await test.app.inject({ method: "PATCH", url: `/api/admin/users/${userId}/role`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { role: "publisher" } });
    expect(roleChange.statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${freshToken}` } })).statusCode).toBe(401);

    const deleteToken = "prg32-delete-token";
    addToken(test.databasePath, userId, deleteToken);
    const deleted = await test.app.inject({ method: "DELETE", url: `/api/admin/users/${userId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } });
    expect(deleted.statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${deleteToken}` } })).statusCode).toBe(401);
    const secondAnonymousCsrf = await test.app.inject({ method: "GET", url: "/auth/csrf" });
    const secondAnonymousCookie = header(secondAnonymousCsrf, "set-cookie").split(";", 1)[0] ?? "";
    const loginAfterDelete = await test.app.inject({ method: "POST", url: "/auth/login", headers: { cookie: secondAnonymousCookie, "x-csrftoken": secondAnonymousCsrf.json<{ csrf_token: string }>().csrf_token }, payload: { username: "credential-user", password: "new-credential-password-123" } });
    expect(loginAfterDelete.statusCode).toBe(401);
  });

  it("protects self and final-administrator transitions transactionally", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const selfDemote = await test.app.inject({ method: "PATCH", url: `/api/admin/users/${admin.userId}/role`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { role: "user" } });
    expect(selfDemote.statusCode).toBe(409);
    expect(responseCode(selfDemote)).toBe("self_demotion_forbidden");
    const selfDelete = await test.app.inject({ method: "DELETE", url: `/api/admin/users/${admin.userId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } });
    expect(selfDelete.statusCode).toBe(409);
    expect(responseCode(selfDelete)).toBe("self_deletion_forbidden");

    const second = await test.app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { username: "second-admin", email: "second-admin@example.test", password: "second-admin-password-123", role: "admin" } });
    const secondId = second.json<{ user: { id: number } }>().user.id;
    const db1 = new Database(test.databasePath);
    const db2 = new Database(test.databasePath);
    db1.pragma("busy_timeout = 5000"); db2.pragma("busy_timeout = 5000");
    const service1 = new AdminIdentityService({ config: test.config, database: db1, writableDatabase: db1, audit: new AdminAuditLog(test.config) });
    const service2 = new AdminIdentityService({ config: test.config, database: db2, writableDatabase: db2, audit: new AdminAuditLog(test.config) });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => service1.setRole(secondId, "user", { actorUserId: admin.userId, requestId: "concurrent-one" })),
      Promise.resolve().then(() => service2.setRole(admin.userId, "user", { actorUserId: secondId, requestId: "concurrent-two" }))
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const after = new Database(test.databasePath);
    expect((after.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as { count: number }).count).toBe(1);
    after.close(); db1.close(); db2.close();
  });

  it("persists bounded audit events and fails closed before a broken audit path", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const created = await test.app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { username: "audited-user", email: "audited@example.test", password: "audited-password-123" } });
    expect(created.statusCode).toBe(201);
    const auditPath = path.join(test.authRoot, "admin-audit.jsonl");
    expect(fs.existsSync(auditPath)).toBe(true);
    const events = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((event) => event.action === "user.create" && event.outcome === "committed" && event.actor_user_id === admin.userId)).toBe(true);
    expect(fs.readFileSync(auditPath, "utf8")).not.toContain("audited-password");
    expect(fs.readFileSync(auditPath, "utf8")).not.toContain("password_hash");

    const brokenPath = path.join(test.authRoot, "admin-audit.jsonl");
    fs.rmSync(brokenPath, { force: true });
    fs.mkdirSync(brokenPath);
    const directDb = new Database(test.databasePath);
    const direct = new AdminIdentityService({ config: test.config, database: directDb, writableDatabase: directDb });
    expect(() => direct.createUser({ username: "blocked-user", email: "blocked@example.test", password: "blocked-password-123" }, { actorUserId: admin.userId, requestId: "broken-audit" })).toThrow();
    expect((directDb.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'blocked-user'").get() as { count: number }).count).toBe(0);
    directDb.close();
  });

  it("lists and revokes administrator-visible token metadata without exposing credentials", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const adminBearer = "prg32-admin-list-token";
    addToken(test.databasePath, admin.userId, adminBearer);
    const db = new Database(test.databasePath);
    const owner = db.prepare("INSERT INTO users(username, email, role) VALUES (?, ?, 'user')").run("token-owner", "token-owner@example.test");
    const ownerId = Number(owner.lastInsertRowid);
    const tokenA = "prg32-owner-token-a";
    const tokenB = "prg32-owner-token-b";
    const tokenAId = Number(db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(ownerId, hashApiToken(tokenA), "owner A").lastInsertRowid);
    const tokenBId = Number(db.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)").run(ownerId, hashApiToken(tokenB), "owner B").lastInsertRowid);
    db.prepare("DELETE FROM groups WHERE name = 'editors'").run();
    db.close();

    const adminBearerList = await test.app.inject({ method: "GET", url: "/api/admin/tokens?limit=1&page=1&user_id=" + ownerId, headers: { authorization: `Bearer ${adminBearer}` } });
    expect(adminBearerList.statusCode).toBe(200);
    expect(adminBearerList.json<{ tokens: Array<Record<string, unknown>>; total: number }>().total).toBe(2);
    expect(adminBearerList.json<{ tokens: Array<Record<string, unknown>> }>().tokens).toHaveLength(1);
    expect(adminBearerList.body).toContain("token-owner");
    expect(adminBearerList.body).not.toContain(tokenA);
    expect(adminBearerList.body).not.toContain(hashApiToken(tokenA));
    expect(adminBearerList.body).not.toContain("password_hash");

    const invalidQuery = await test.app.inject({ method: "GET", url: "/api/admin/tokens?unexpected=true", headers: { cookie: admin.cookie } });
    expect(invalidQuery.statusCode).toBe(400);
    expect(responseCode(invalidQuery)).toBe("unknown_field");

    const ordinary = "prg32-ordinary-token-admin";
    addToken(test.databasePath, ownerId, ordinary);
    const ordinaryDenied = await test.app.inject({ method: "GET", url: "/api/admin/tokens", headers: { authorization: `Bearer ${ordinary}` } });
    expect(ordinaryDenied.statusCode).toBe(403);

    const beforeA = await test.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${tokenA}` } });
    const beforeB = await test.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${tokenB}` } });
    expect(beforeA.statusCode).toBe(200);
    expect(beforeB.statusCode).toBe(200);
    const missingCsrf = await test.app.inject({ method: "DELETE", url: `/api/admin/tokens/${tokenAId}`, headers: { cookie: admin.cookie } });
    expect(missingCsrf.statusCode).toBe(403);
    const bearerMutation = await test.app.inject({ method: "DELETE", url: `/api/admin/tokens/${tokenAId}`, headers: { authorization: `Bearer ${adminBearer}` } });
    expect(bearerMutation.statusCode).toBe(403);
    const revoked = await test.app.inject({ method: "DELETE", url: `/api/admin/tokens/${tokenAId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.body).not.toContain(tokenA);
    expect((await test.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${tokenA}` } })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${tokenB}` } })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "DELETE", url: `/api/admin/tokens/${tokenAId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } })).statusCode).toBe(404);
    expect(responseCode(await test.app.inject({ method: "DELETE", url: "/api/admin/tokens/0", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } }))).toBe("invalid_identifier");

    const brokenAudit = path.join(test.authRoot, "admin-audit.jsonl");
    fs.rmSync(brokenAudit, { force: true });
    fs.mkdirSync(brokenAudit);
    const blocked = await test.app.inject({ method: "DELETE", url: `/api/admin/tokens/${tokenBId}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } });
    expect(blocked.statusCode).toBe(503);
    expect(responseCode(blocked)).toBe("admin_audit_unavailable");
    const stillValid = await test.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${tokenB}` } });
    expect(stillValid.statusCode).toBe(200);
  });

  it("disables accounts, revokes durable access, and preserves last-admin protection", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const created = await test.app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { username: "disable-me", email: "disable-me@example.test", password: "disable-password-123" } });
    const userId = created.json<{ user: { id: number } }>().user.id;
    const anonymous = await test.app.inject({ method: "GET", url: "/auth/csrf" });
    const cookie = header(anonymous, "set-cookie").split(";", 1)[0] ?? "";
    const login = await test.app.inject({ method: "POST", url: "/auth/login", headers: { cookie, "x-csrftoken": anonymous.json<{ csrf_token: string }>().csrf_token }, payload: { username: "disable-me", password: "disable-password-123" } });
    const oldCookie = header(login, "set-cookie").split(";", 1)[0] ?? "";
    const token = "prg32-disable-me-token";
    addToken(test.databasePath, userId, token);
    expect((await test.app.inject({ method: "GET", url: "/api/me", headers: { cookie: oldCookie } })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    const disabled = await test.app.inject({ method: "PATCH", url: `/api/admin/users/${userId}/state`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { disabled: true } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<{ user: { disabled_at: string | null } }>().user.disabled_at).toBeTypeOf("string");
    expect((await test.app.inject({ method: "GET", url: "/api/me", headers: { cookie: oldCookie } })).statusCode).toBe(401);
    expect((await test.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    const enabled = await test.app.inject({ method: "PATCH", url: `/api/admin/users/${userId}/state`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { disabled: false } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<{ user: { disabled_at: string | null } }>().user.disabled_at).toBeNull();
    expect((await test.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    const selfDisable = await test.app.inject({ method: "PATCH", url: `/api/admin/users/${admin.userId}/state`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { disabled: true } });
    expect(selfDisable.statusCode).toBe(409);
    expect(responseCode(selfDisable)).toBe("self_disable_forbidden");
  });
});
