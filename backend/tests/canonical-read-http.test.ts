import fs from "node:fs";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { CANONICAL_READ_AUTHORIZATION } from "../src/storage-v2/read-mode.js";
import { CanonicalCatalog } from "../src/storage-v2/catalog.js";
import { createDisposableCanonicalReadFixture, disposeDifferentialFixtures } from "../src/storage-v2/differential/harness.js";

afterEach(() => disposeDifferentialFixtures());

function canonicalEnvironment(fixture: ReturnType<typeof createDisposableCanonicalReadFixture>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PRG32_BACKEND_DB: `${fixture.sourceRoot}/store.sqlite`,
    PRG32_BACKEND_STORE_DATA: fixture.sourceRoot,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: fixture.targetRoot,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: CANONICAL_READ_AUTHORIZATION
  };
}

describe("Fastify canonical disposable read integration", () => {
  it("serves catalog, detail, media, colophon, architecture, and download through the actual routes", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const app = buildApp({ config: loadConfig(canonicalEnvironment(fixture)), logger: false });

    const listing = await app.inject({ method: "GET", url: "/api/games" });
    expect(listing.statusCode).toBe(200);
    const listingBody = JSON.parse(listing.body) as { games: Array<{ id: string }> };
    expect(listingBody.games.map((item) => item.id)).toEqual(["org.example.alpha", "org.example.beta"]);

    const versionedListing = await app.inject({ method: "GET", url: "/api/v1/games" });
    expect(versionedListing.statusCode).toBe(200);
    expect((JSON.parse(versionedListing.body) as { games: Array<{ id: string }> }).games).toEqual(listingBody.games);

    const detail = await app.inject({ method: "GET", url: "/api/games/org.example.alpha?version=2.0.0" });
    expect(detail.statusCode).toBe(200);
    const detailBody = JSON.parse(detail.body) as { game: { selected_version: string; architectures: string[] } };
    expect(detailBody.game.selected_version).toBe("2.0.0");
    expect(detailBody.game.architectures).toEqual(["esp32c6", "qemu"]);

    const icon = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/icon?version=2.0.0&architecture=qemu" });
    const screenshot = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/screenshot?version=2.0.0&architecture=qemu" });
    const colophon = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/colophon?version=2.0.0" });
    const download = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/png");
    expect(icon.rawPayload.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
    expect(screenshot.statusCode).toBe(200);
    expect(screenshot.rawPayload.toString("hex")).toBe("89504e470d0a1a0a5343524e");
    expect(colophon.statusCode).toBe(200);
    const colophonBody = JSON.parse(colophon.body) as { colophon: { abi: string } };
    expect(colophonBody.colophon.abi).toBe("prg32-colophon-1.0");
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe("attachment; filename=org.example.alpha-2.0.0-qemu.prg32");
    expect(download.headers["content-type"]).toBe("application/vnd.prg32.cartridge");
    expect(download.rawPayload.length).toBeGreaterThan(72);
    const range = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu", headers: { range: "bytes=0-7" } });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(download.rawPayload.subarray(0, 8));
    const conditional = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu", headers: { "if-none-match": String(download.headers.etag) } });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.rawPayload.length).toBe(0);

    const unsupported = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?architecture=unsupported" });
    const unpublished = await app.inject({ method: "GET", url: "/api/games/org.example.beta?version=9.9.9" });
    expect(unsupported.statusCode).toBe(400);
    expect(unpublished.statusCode).toBe(400);
    expect(unsupported.body).not.toContain("storage/");

    await app.close();
  }, 60_000);

  it("keeps the canonical database and object files read-only while serving downloads", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const databasePath = `${fixture.targetRoot}/store.sqlite`;
    const beforeDatabase = fs.readFileSync(databasePath);
    const before = new Database(databasePath, { readonly: true, fileMustExist: true });
    const beforeTelemetry = Number((before.prepare("SELECT COUNT(*) AS count FROM download_events").get() as { count: number }).count);
    before.close();
    const app = buildApp({ config: loadConfig(canonicalEnvironment(fixture)), logger: false });
    const response = await app.inject({ method: "GET", url: "/api/games/org.example.alpha/download?architecture=qemu" });
    expect(response.statusCode).toBe(200);
    await app.close();
    expect(fs.readFileSync(databasePath)).toEqual(beforeDatabase);
  const catalog = new CanonicalCatalog(fixture.targetRoot, { legacyRoots: [fixture.sourceRoot, `${fixture.sourceRoot}/store.sqlite`] });
    expect(catalog.isReadOnly()).toBe(true);
    catalog.close();

    const readonly = new Database(databasePath, { readonly: true, fileMustExist: true });
    const afterTelemetry = Number((readonly.prepare("SELECT COUNT(*) AS count FROM download_events").get() as { count: number }).count);
    expect(afterTelemetry).toBe(beforeTelemetry);
    expect(() => readonly.exec("CREATE TABLE forbidden_write(id INTEGER)" )).toThrow();
    readonly.close();
  }, 60_000);

  it("does not let unpublished active cartridges break the public or administrative listing", () => {
    const fixture = createDisposableCanonicalReadFixture();
    const database = new Database(`${fixture.targetRoot}/store.sqlite`);
    database.prepare("INSERT INTO cartridges(cartridge_id, created_at, updated_at, state) VALUES (?, ?, ?, 'active')").run("pending-only", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.close();
    const catalog = new CanonicalCatalog(fixture.targetRoot, { legacyRoots: [fixture.sourceRoot] });
    expect(catalog.listGames().map((game) => game.id)).toEqual(["org.example.alpha", "org.example.beta"]);
    catalog.close();
  });

  it("uses canonical settings for discovery without opening the legacy shadow database", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const canonicalDatabase = new Database(`${fixture.targetRoot}/store.sqlite`);
    canonicalDatabase.prepare("INSERT INTO store_settings(key, value) VALUES ('store_name', ?)").run("Canonical Disposable Store");
    canonicalDatabase.close();
  const sourceDatabase = `${fixture.sourceRoot}/store.sqlite`;
    const unavailableSource = `${sourceDatabase}.temporarily-unavailable`;
    const app = buildApp({ config: loadConfig(canonicalEnvironment(fixture)), logger: false });
    fs.renameSync(sourceDatabase, unavailableSource);
    try {
      const discovery = await app.inject({ method: "GET", url: "/.well-known/prg32-store.json", headers: { host: "canonical.test" } });
      expect(discovery.statusCode).toBe(200);
      const discoveryBody = JSON.parse(discovery.body) as {
        name: string;
        api_version: string;
        api_base: string;
        api_versions: Array<{ version: string; status: string; base_url: string }>;
        services_v1: { cartridges: string };
      };
      expect(discoveryBody.name).toBe("Canonical Disposable Store");
      expect(discoveryBody.api_version).toBe("v1");
      expect(discoveryBody.api_base).toBe("http://canonical.test/api/v1");
      expect(discoveryBody.api_versions).toEqual([{ version: "v1", status: "stable", base_url: "http://canonical.test/api/v1" }]);
      expect(discoveryBody.services_v1.cartridges).toBe("http://canonical.test/api/v1/games");
      const statistics = await app.inject({ method: "GET", url: "/api/stats/scores" });
      expect(statistics.statusCode).toBe(200);
    } finally {
      fs.renameSync(unavailableSource, sourceDatabase);
      await app.close();
    }
  }, 60_000);

  it("fails closed unless canonical mode, root, marker, and exact authorization are all present", () => {
    const fixture = createDisposableCanonicalReadFixture();
    const base = canonicalEnvironment(fixture);
    expect(() => loadConfig({ ...base, PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: "wrong" })).toThrow(/CANONICAL_READ_AUTHORIZATION is invalid/);
    expect(() => loadConfig({ ...base, PRG32_BACKEND_CANONICAL_STORAGE_ROOT: undefined })).toThrow(/CANONICAL_STORAGE_ROOT is required/);
    expect(loadConfig({ PRG32_BACKEND_DB: "/missing/store.sqlite" }).catalogReadMode).toBe("legacy");
  });
});
