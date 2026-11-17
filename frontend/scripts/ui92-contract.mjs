import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  apiErrorSchema,
  downloadStatsSchema,
  gameResponseSchema,
  gamesResponseSchema,
  runStatsSchema,
  scoreStatsSchema,
  scoresSchema,
  userProfileResponseSchema,
  userRunsResponseSchema,
} from "../src/lib/api/schemas.ts";

const baseUrl = process.env.PRG32_UI92_BACKEND_URL?.trim();
const expectedHash = process.env.PRG32_UI92_EXPECTED_DOWNLOAD_SHA256?.trim();
const expectedBytes = Number(process.env.PRG32_UI92_EXPECTED_DOWNLOAD_BYTES ?? "0");
if (!baseUrl || !expectedHash || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
  throw new Error("UI.9.2 contract verification requires disposable backend and artifact expectations");
}

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let body = null;
  try { body = JSON.parse(text); } catch { /* binary response */ }
  return { response, bytes, body };
}

function parse(schema, result, label) {
  assert.equal(result.response.headers.get("content-type"), "application/json", `${label} content type`);
  const parsed = schema.safeParse(result.body);
  assert.equal(parsed.success, true, `${label} Zod schema: ${parsed.success ? "ok" : parsed.error.message}`);
  return parsed.success ? parsed.data : null;
}

function parseError(result, label, status) {
  assert.equal(result.response.status, status, `${label} status`);
  const parsed = apiErrorSchema.safeParse(result.body);
  assert.equal(parsed.success, true, `${label} error envelope: ${parsed.success ? "ok" : parsed.error.message}`);
  assert.equal(result.body?.ok, false, `${label} error flag`);
  assert.equal(typeof result.body?.error, "string", `${label} safe error message`);
  assert.equal(JSON.stringify(result.body).includes("sqlite"), false, `${label} must not leak filesystem details`);
}

const ready = await request("/ready");
assert.equal(ready.response.status, 200, "Fastify readiness status");
assert.equal(ready.body?.ok, true, "Fastify readiness body");

const listing = parse(gamesResponseSchema, await request("/api/games"), "catalog list");
assert.deepEqual(listing?.games.map((game) => game.id), ["org.example.alpha", "org.example.beta"]);
assert.equal(listing?.pagination.total, 2);

const paged = parse(gamesResponseSchema, await request("/api/games?q=alpha&page=1&per_page=1"), "catalog search/pagination");
assert.deepEqual(paged?.games.map((game) => game.id), ["org.example.alpha"]);
assert.equal(paged?.pagination.per_page, 1);

const empty = parse(gamesResponseSchema, await request("/api/games?q=does-not-exist"), "catalog empty result");
assert.deepEqual(empty?.games, []);
assert.equal(empty?.pagination.total, 0);
assert.equal(empty?.pagination.pages, 1);

const detail = parse(gameResponseSchema, await request("/api/games/org.example.alpha?version=2.0.0"), "game detail");
assert.equal(detail?.game.selected_version, "2.0.0");
assert.deepEqual(detail?.game.architectures, ["esp32c6", "qemu"]);

const scores = parse(scoresSchema, await request("/api/scores?limit=20"), "scores");
assert.equal(scores?.[0]?.game, "org.example.alpha");

const downloadStats = parse(downloadStatsSchema, await request("/api/stats/downloads?granularity=day&limit=30"), "download statistics");
assert.equal(downloadStats?.total, 3);
const scoreStats = parse(scoreStatsSchema, await request("/api/stats/scores?limit=5"), "score statistics");
assert.equal(scoreStats?.scores.length, 1);
const runStats = parse(runStatsSchema, await request("/api/stats/runs"), "run statistics");
assert.equal(runStats?.total, 1);

const profile = parse(userProfileResponseSchema, await request("/api/users/fixture-user"), "public profile");
assert.equal(profile?.user.username, "fixture-user");
assert.equal(profile?.run_count, 0);
const anonymousRuns = await request("/api/users/fixture-user/runs");
parseError(anonymousRuns, "anonymous profile runs", 403);
const unknownRun = await request("/api/users/fixture-user/runs/does-not-exist");
parseError(unknownRun, "unknown run", 404);
const unknownUser = await request("/api/users/does-not-exist");
parseError(unknownUser, "unknown profile", 404);

const download = await request("/api/games/org.example.alpha/download?version=2.0.0&architecture=qemu");
assert.equal(download.response.status, 200, "download status");
assert.equal(download.response.headers.get("content-type"), "application/vnd.prg32.cartridge", "download content type");
assert.match(download.response.headers.get("content-disposition") ?? "", /attachment; filename=org\.example\.alpha-2\.0\.0-qemu\.prg32/u);
assert.equal(download.bytes.byteLength, expectedBytes, "download byte length");
assert.equal(crypto.createHash("sha256").update(download.bytes).digest("hex"), expectedHash, "download SHA-256");
assert.equal(new TextDecoder().decode(download.bytes.subarray(0, 4)), "PRG2", "download cartridge signature");

parseError(await request("/api/games/does-not-exist"), "unknown game", 400);
parseError(await request("/api/games/org.example.alpha?version=9.9.9"), "unknown version", 400);
parseError(await request("/api/games/org.example.alpha/download?architecture=unsupported"), "unsupported architecture", 400);
parseError(await request("/api/auth/me"), "anonymous authentication", 401);

console.log("UI92_CONTRACTS_GO endpoints=19 schemas=10 download=sha256-verified errors=7");
