import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

interface OracleResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body_base64: string;
  readonly sha256: string;
}

interface M3Oracle {
  readonly index: Record<string, unknown>;
  readonly files: Record<string, string>;
  readonly requests: Record<string, OracleResponse>;
}

const oracle = JSON.parse(
  fs.readFileSync(new URL("./fixtures/m3-python-oracle.json", import.meta.url), "utf8")
) as M3Oracle;
const temporaryDirectories: string[] = [];

function createStore(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m3-fastify-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(path.join(directory, "index.json"), `${JSON.stringify(oracle.index)}\n`);
  for (const [filename, encoded] of Object.entries(oracle.files)) {
    const target = path.join(directory, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(encoded, "base64"));
    fs.utimesSync(target, 1_700_000_000, 1_700_000_000);
  }
  return directory;
}

function assertOracleResponse(response: { statusCode: number; headers: Record<string, string | string[] | undefined>; rawPayload: Buffer }, expected: OracleResponse): void {
  expect(response.statusCode).toBe(expected.status);
  expect(response.rawPayload.toString("base64")).toBe(expected.body_base64);
  expect(crypto.createHash("sha256").update(response.rawPayload).digest("hex")).toBe(expected.sha256);
  for (const [name, value] of Object.entries(expected.headers)) {
    expect(response.headers[name]).toBe(value);
  }
}

function headerString(headers: Record<string, unknown>, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("read-only catalog and binary parity", () => {
  it("matches JSON, media, binary, error, range, and conditional responses", async () => {
    const storeDirectory = createStore();
    const databasePath = path.join(storeDirectory, "missing.sqlite");
    const app = buildApp({
      config: loadConfig({
        PRG32_BACKEND_DB: databasePath,
        PRG32_BACKEND_STORE_DATA: storeDirectory
      }),
      logger: false
    });
    const requests: Record<string, string> = {
      discovery: "/.well-known/prg32-store.json",
      listing: "/api/games",
      search_listing: "/api/games?q=synthetic&per_page=1&page=1",
      limit_listing: "/api/games?limit=1&page=2",
      detail: "/api/games/org.example.test?version=1.0.0",
      icon: "/api/games/org.example.test/icon?version=1.0.0&architecture=qemu",
      screenshot: "/api/games/org.example.test/screenshot?version=1.0.0&architecture=qemu",
      colophon: "/api/games/org.example.test/colophon?version=1.0.0&architecture=qemu",
      download: "/api/games/org.example.test/download?version=1.0.0&architecture=qemu",
      download_default: "/api/games/org.example.test/download?version=1.0.0",
      missing_game: "/api/games/does-not-exist",
      invalid_version: "/api/games/org.example.test?version=9.9.9",
      invalid_architecture: "/api/games/org.example.test/download?architecture=unknown",
      missing_screenshot: "/api/games/m3.no-media/screenshot",
      missing_colophon: "/api/games/m3.no-media/colophon",
      range_download: "/api/games/org.example.test/download?version=1.0.0&architecture=qemu"
    };
    for (const [name, url] of Object.entries(requests)) {
      const headers: Record<string, string> = { host: "store.local:5080" };
      if (name === "range_download") headers.range = "bytes=0-7";
      const response = await app.inject({ method: "GET", url, headers });
      assertOracleResponse(response, oracle.requests[name]);
      if (name === "download" || name === "download_default" || name === "range_download") {
        expect(response.headers.etag).toBeTruthy();
      }
    }

    const download = await app.inject({
      method: "GET",
      url: requests.download,
      headers: { host: "store.local:5080" }
    });
    const etag = headerString(download.headers as unknown as Record<string, unknown>, "etag");
    const conditional = await app.inject({
      method: "GET",
      url: requests.download,
      headers: { host: "store.local:5080", "if-none-match": etag }
    });
    expect(conditional.statusCode).toBe(oracle.requests.conditional_download.status);
    expect(Buffer.from(conditional.rawPayload as unknown as Uint8Array).length).toBe(0);

    const corruptIndex = JSON.parse(JSON.stringify(oracle.index)) as Record<string, unknown>;
    const corruptGame = corruptIndex.games as Record<string, unknown>;
    const corruptVersion = (corruptGame["org.example.test"] as Record<string, unknown>).versions as Record<string, unknown>;
    const corruptArchitectures = (corruptVersion["1.0.0"] as Record<string, unknown>).architectures as Record<string, unknown>;
    const corruptVariant = corruptArchitectures.qemu as Record<string, unknown>;
    corruptVariant.filename = "cartridges/org.example.test/1.0.0/corrupt.prg32";
    fs.writeFileSync(path.join(storeDirectory, corruptVariant.filename as string), Buffer.from("PRG2"));
    fs.writeFileSync(path.join(storeDirectory, "index.json"), JSON.stringify(corruptIndex));
    const corruptMedia = await app.inject({ method: "GET", url: "/api/games/org.example.test/icon?architecture=qemu" });
    expect(corruptMedia.statusCode).toBe(400);
    const corruptDownload = await app.inject({ method: "GET", url: "/api/games/org.example.test/download?architecture=qemu" });
    expect(corruptDownload.statusCode).toBe(200);
    expect(Buffer.from(corruptDownload.rawPayload as unknown as Uint8Array)).toEqual(Buffer.from("PRG2"));

    await app.close();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("rejects traversal and symlink escapes without mutating the store", async () => {
    const storeDirectory = createStore();
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m3-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const outsideFile = path.join(outsideDirectory, "outside.prg32");
    fs.writeFileSync(outsideFile, Buffer.from("outside"));
    const unsafeIndex = JSON.parse(JSON.stringify(oracle.index)) as Record<string, unknown>;
    const games = unsafeIndex.games as Record<string, unknown>;
    const game = games["org.example.test"] as Record<string, unknown>;
    const versions = game.versions as Record<string, unknown>;
    const version = versions["1.0.0"] as Record<string, unknown>;
    const architectures = version.architectures as Record<string, unknown>;
    const variant = architectures.esp32c6 as Record<string, unknown>;
    variant.filename = "../outside.prg32";
    fs.writeFileSync(path.join(storeDirectory, "index.json"), JSON.stringify(unsafeIndex));
    const app = buildApp({
      config: loadConfig({
        PRG32_BACKEND_DB: path.join(storeDirectory, "missing.sqlite"),
        PRG32_BACKEND_STORE_DATA: storeDirectory
      }),
      logger: false
    });
    const traversal = await app.inject({ method: "GET", url: "/api/games/org.example.test/download?architecture=esp32c6" });
    expect(traversal.statusCode).toBe(400);

    variant.filename = "cartridges/org.example.test/1.0.0/escape.prg32";
    const linkPath = path.join(storeDirectory, variant.filename as string);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(outsideFile, linkPath);
    fs.writeFileSync(path.join(storeDirectory, "index.json"), JSON.stringify(unsafeIndex));
    const symlink = await app.inject({ method: "GET", url: "/api/games/org.example.test/download?architecture=esp32c6" });
    expect(symlink.statusCode).toBe(400);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside");
    fs.writeFileSync(path.join(outsideDirectory, "index.json"), JSON.stringify(oracle.index));
    fs.rmSync(path.join(storeDirectory, "index.json"));
    fs.symlinkSync(path.join(outsideDirectory, "index.json"), path.join(storeDirectory, "index.json"));
    const indexSymlink = await app.inject({ method: "GET", url: "/api/games" });
    expect(indexSymlink.statusCode).toBe(400);
    await app.close();
  });
});
