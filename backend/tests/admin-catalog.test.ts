import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashApiToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/env.js";
import { fileSha256 } from "../src/catalog/catalog.js";
import { parseCartridge, buildSubmissionCartridge } from "../src/submission/prg32.js";

const roots: string[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];
const BOOTSTRAP = "catalog-admin-bootstrap-token-1234567890";
const GAME_ID = "org.example.catalog";
const VERSION = "1.0.0";
const PNG = Buffer.from("\x89PNG\r\n\x1a\n", "binary");

interface CatalogIndex {
  readonly games: Record<string, { readonly versions: Record<string, { readonly architectures: Record<string, { readonly sha256: string }> }> }>;
}

function legacy(): Buffer {
  const output = Buffer.alloc(84);
  output.write("PRG2", 0, "ascii");
  output.writeUInt16LE(1, 4);
  output.writeUInt16LE(72, 8);
  output.writeUInt32LE(12, 16);
  Buffer.from("\x13\x00\x00\x00\x13\x00\x00\x00\x13\x00\x00\x00", "binary").copy(output, 72);
  return output;
}

function cartridge(architecture: "qemu" | "esp32c6", title = "Catalog Game"): Buffer {
  return Buffer.from(buildSubmissionCartridge(legacy(), {
    abi: "prg32-metadata-1.0",
    id: GAME_ID,
    title,
    summary: "A catalog fixture",
    description: "A catalog fixture description",
    version: VERSION,
    authors: [{ name: "PRG32" }],
    tags: ["fixture"],
    license: "MIT",
    assets: { icon: "icon.png" }
  }, PNG, architecture, null, {
    abi: "prg32-colophon-1.0",
    title,
    version: VERSION,
    developer: { name: "PRG32" },
    authors: [{ name: "PRG32" }],
    controls: []
  }));
}

function fixture(): { readonly root: string; readonly storeRoot: string; readonly authRoot: string; readonly databasePath: string; readonly app: ReturnType<typeof buildApp> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m63d2e-catalog-"));
  roots.push(root);
  const storeRoot = path.join(root, "store");
  const authRoot = path.join(root, "auth-workspace");
  const databasePath = path.join(authRoot, "auth.sqlite");
  fs.mkdirSync(storeRoot);
  fs.mkdirSync(authRoot);
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', external_id TEXT, external_provider TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT);
    CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY(user_id, group_id));
    CREATE TABLE registration_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE store_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO groups(name) VALUES ('editors');
  `);
  const variants: Record<string, Record<string, unknown>> = {};
  const versionRoot = path.join(storeRoot, "cartridges", GAME_ID, VERSION);
  fs.mkdirSync(versionRoot, { recursive: true });
  for (const architecture of ["qemu", "esp32c6"] as const) {
    const image = cartridge(architecture);
    const relative = `cartridges/${GAME_ID}/${VERSION}/${architecture}.prg32`;
    fs.writeFileSync(path.join(storeRoot, relative), image);
    variants[architecture] = {
      architecture,
      filename: relative,
      size: image.byteLength,
      sha256: fileSha256(path.join(storeRoot, relative)),
      icon_mime: "image/png",
      screenshot_mime: null,
      has_screenshot: false,
      has_signature: false,
      updated_at: "2026-01-01T00:00:00.000Z",
      published_by: "fixture"
    };
  }
  const metadata = {
    abi: "prg32-metadata-1.0", id: GAME_ID, title: "Catalog Game", summary: "A catalog fixture",
    description: "A catalog fixture description", version: VERSION, authors: [{ name: "PRG32" }], tags: ["fixture"],
    license: "MIT", assets: { icon: "icon.png" }
  };
  fs.writeFileSync(path.join(storeRoot, "index.json"), JSON.stringify({
    abi: "prg32-cartridge-store-index-1.0", updated_at: "2026-01-01T00:00:00.000Z", games: {
      [GAME_ID]: {
        id: GAME_ID, title: "Catalog Game", summary: "A catalog fixture", authors: [{ name: "PRG32" }], tags: ["fixture"],
        latest_version: VERSION, updated_at: "2026-01-01T00:00:00.000Z", versions: {
          [VERSION]: { version: VERSION, published_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", metadata, colophon: { abi: "prg32-colophon-1.0", title: "Catalog Game", version: VERSION }, architectures: variants }
        }
      }
    }
  }));
  database.close();
  const shadow = path.join(root, "shadow.sqlite");
  fs.writeFileSync(shadow, Buffer.from("shadow"));
  const app = buildApp({ config: loadConfig({
    PRG32_BACKEND_DB: shadow,
    PRG32_BACKEND_STORE_DATA: storeRoot,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: databasePath,
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: authRoot,
    PRG32_BACKEND_SUBMISSION_WRITE_ENABLED: "true",
    PRG32_BACKEND_SUBMISSION_WRITE_MODE: "test",
    PRG32_BACKEND_SUBMISSION_DISPOSABLE_ROOT: storeRoot,
    PRG32_BACKEND_SESSION_SECRET: "catalog-admin-session-secret-1234567890",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false"
  }), logger: false });
  apps.push(app);
  return { root, storeRoot, authRoot, databasePath, app };
}

function header(response: { readonly headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function adminSession(app: ReturnType<typeof buildApp>): Promise<{ readonly cookie: string; readonly csrf: string; readonly userId: number }> {
  const bootstrap = await app.inject({ method: "POST", url: "/auth/bootstrap", headers: { "x-prg32-bootstrap-token": BOOTSTRAP }, payload: { username: "catalog-admin", email: "catalog-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" } });
  expect(bootstrap.statusCode).toBe(201);
  const cookie = header(bootstrap, "set-cookie").split(";", 1)[0] ?? "";
  const csrf = (await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } })).json<{ csrf_token: string }>().csrf_token;
  return { cookie, csrf, userId: bootstrap.json<{ user: { id: number } }>().user.id };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("catalog administration", () => {
  it("lists and updates a cartridge through the durable publication pipeline", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const list = await test.app.inject({ method: "GET", url: "/api/admin/cartridges?version=1.0.0", headers: { cookie: admin.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ cartridges: Array<Record<string, unknown>> }>().cartridges[0]).toMatchObject({ id: GAME_ID, selected_version: VERSION, publication_state: "published", artifact_state: "available" });
    expect(list.body).not.toContain("filename");
    expect(list.body).not.toContain(test.storeRoot);

    const updated = await test.app.inject({ method: "PATCH", url: `/api/admin/cartridges/${GAME_ID}?version=${VERSION}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { title: "Updated Catalog Game", tags: ["safe", "catalog"] } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ cartridge: Record<string, unknown> }>().cartridge).toMatchObject({ title: "Updated Catalog Game", tags: ["safe", "catalog"] });
    const image = fs.readFileSync(path.join(test.storeRoot, "cartridges", GAME_ID, VERSION, "qemu.prg32"));
    expect(parseCartridge(image).metadata).toMatchObject({ title: "Updated Catalog Game", tags: ["safe", "catalog"] });
    const index = JSON.parse(fs.readFileSync(path.join(test.storeRoot, "index.json"), "utf8")) as CatalogIndex;
    expect(index.games[GAME_ID]?.versions[VERSION]?.architectures.qemu.sha256).toBe(fileSha256(path.join(test.storeRoot, "cartridges", GAME_ID, VERSION, "qemu.prg32")));
    expect((await test.app.inject({ method: "GET", url: `/api/games/${GAME_ID}/download?version=${VERSION}&architecture=qemu` })).statusCode).toBe(200);
    expect((await test.app.inject({ method: "GET", url: `/api/games/${GAME_ID}/download?version=${VERSION}&architecture=qemu` })).rawPayload).toEqual(image);

    const forbidden = await test.app.inject({ method: "PATCH", url: `/api/admin/cartridges/${GAME_ID}?version=${VERSION}`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf }, payload: { authors: [{ name: "attacker" }] } });
    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.json<{ code: string }>().code).toBe("unknown_field");
    const noCsrf = await test.app.inject({ method: "PATCH", url: `/api/admin/cartridges/${GAME_ID}?version=${VERSION}`, headers: { cookie: admin.cookie }, payload: { title: "Rejected" } });
    expect(noCsrf.statusCode).toBe(403);

    const audit = fs.readFileSync(path.join(test.authRoot, "admin-audit.jsonl"), "utf8");
    expect(audit).toContain("catalog.metadata.update");
  });

  it("enforces centralized catalog RBAC and deletes one architecture without touching the other", async () => {
    const test = fixture();
    const admin = await adminSession(test.app);
    const database = new Database(test.databasePath);
    const ordinary = database.prepare("INSERT INTO users(username, email, role) VALUES ('ordinary', 'ordinary@example.test', 'user')").run();
    database.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, 'ordinary')").run(Number(ordinary.lastInsertRowid), hashApiToken("ordinary-catalog-token"));
    database.prepare("INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, 'admin')").run(admin.userId, hashApiToken("admin-catalog-token"));
    database.close();
    const ordinaryRead = await test.app.inject({ method: "GET", url: "/api/admin/cartridges", headers: { authorization: "Bearer ordinary-catalog-token" } });
    expect(ordinaryRead.statusCode).toBe(403);
    const bearerMutation = await test.app.inject({ method: "DELETE", url: `/api/admin/cartridges/${GAME_ID}?version=${VERSION}&architecture=qemu`, headers: { authorization: "Bearer admin-catalog-token" } });
    expect(bearerMutation.statusCode).toBe(403);
    expect(bearerMutation.json<{ code: string }>().code).toBe("admin_browser_session_required");

    const deleted = await test.app.inject({ method: "DELETE", url: `/api/admin/cartridges/${GAME_ID}?version=${VERSION}&architecture=qemu`, headers: { cookie: admin.cookie, "x-csrftoken": admin.csrf } });
    expect(deleted.statusCode).toBe(200);
    expect(fs.existsSync(path.join(test.storeRoot, "cartridges", GAME_ID, VERSION, "qemu.prg32"))).toBe(false);
    expect(fs.existsSync(path.join(test.storeRoot, "cartridges", GAME_ID, VERSION, "esp32c6.prg32"))).toBe(true);
    expect((await test.app.inject({ method: "GET", url: `/api/games/${GAME_ID}/download?version=${VERSION}&architecture=qemu` })).statusCode).toBe(400);
    expect((await test.app.inject({ method: "GET", url: `/api/games/${GAME_ID}/download?version=${VERSION}&architecture=esp32c6` })).statusCode).toBe(200);
  });
});
