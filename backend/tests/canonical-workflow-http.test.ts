import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { openTargetStorage } from "../src/storage-v2/database.js";
import { CanonicalWorkflowService } from "../src/storage-v2/workflow.js";
import { CanonicalWriterLease } from "../src/storage-v2/writer-lock.js";
import { CANONICAL_READ_AUTHORIZATION, CANONICAL_WRITE_AUTHORIZATION } from "../src/storage-v2/read-mode.js";
import { createDisposableCanonicalReadFixture, disposeDifferentialFixtures } from "../src/storage-v2/differential/harness.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const BOOTSTRAP = "m52g2-disposable-bootstrap-token-1234567890";
const SESSION_SECRET = "m52g2-disposable-session-secret-1234567890";

function legacyCartridge(): Buffer {
  const bytes = Buffer.alloc(84);
  bytes.write("PRG2", 0, "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(72, 8);
  bytes.writeUInt32LE(12, 16);
  Buffer.from("130000001300000013000000", "hex").copy(bytes, 72);
  return bytes;
}

function bundle(id = "org.example.canonical", version = "1.0.0"): Buffer {
  return Buffer.from(zipSync({
    "manifest.json": Buffer.from(JSON.stringify({
      abi: "prg32-metadata-1.0",
      id,
      title: "Canonical Submission",
      version,
      authors: [{ name: "PRG32" }],
      tags: ["canonical"],
      assets: { icon: "icon.png" },
      architectures: [{ id: "qemu", file: "game-qemu.prg32" }]
    })),
    "icon.png": PNG,
    "game-qemu.prg32": legacyCartridge()
  }));
}

function environment(fixture: ReturnType<typeof createDisposableCanonicalReadFixture>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PRG32_BACKEND_DB: path.join(fixture.sourceRoot, "store.sqlite"),
    PRG32_BACKEND_STORE_DATA: fixture.sourceRoot,
    PRG32_BACKEND_CATALOG_READ_MODE: "canonical-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: fixture.targetRoot,
    PRG32_BACKEND_CANONICAL_READ_AUTHORIZATION: CANONICAL_READ_AUTHORIZATION,
    PRG32_BACKEND_CANONICAL_WORKFLOW_MODE: "disposable",
    PRG32_BACKEND_CANONICAL_WRITE_AUTHORIZATION: CANONICAL_WRITE_AUTHORIZATION,
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: path.join(fixture.targetRoot, "store.sqlite"),
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: fixture.targetRoot,
    PRG32_BACKEND_SESSION_SECRET: SESSION_SECRET,
    PRG32_BACKEND_BOOTSTRAP_TOKEN: BOOTSTRAP,
    PRG32_BACKEND_SESSION_SECURE: "false"
  };
}

function header(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function authenticate(app: ReturnType<typeof buildApp>): Promise<{ cookie: string; csrf: string }> {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/auth/bootstrap",
    headers: { "x-prg32-bootstrap-token": BOOTSTRAP },
    payload: { username: "canonical-admin", email: "canonical-admin@example.test", password: "long-password-123", password_confirm: "long-password-123" }
  });
  expect(bootstrap.statusCode).toBe(201);
  const cookie = header(bootstrap, "set-cookie").split(";", 1)[0] ?? "";
  const csrfResponse = await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie } });
  expect(csrfResponse.statusCode).toBe(200);
  return { cookie, csrf: (JSON.parse(csrfResponse.body) as { csrf_token: string }).csrf_token };
}

function multipart(bytes: Uint8Array, csrf?: string): { body: Buffer; contentType: string } {
  const boundary = "----prg32-m52g2-boundary";
  const csrfPart = csrf === undefined
    ? Buffer.alloc(0)
    : Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf_token"\r\n\r\n${csrf}\r\n`);
  return {
    body: Buffer.concat([
      csrfPart,
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

afterEach(() => disposeDifferentialFixtures());

describe("canonical disposable submission, review, and publication", () => {
  it("runs the actual HTTP submission/review/publication workflow and exposes the result through canonical reads", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const app = buildApp({ config: loadConfig(environment(fixture)), logger: false });
    const auth = await authenticate(app);
    const publishingDisabled = await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf }, payload: { application_settings: { "publishing.enabled": false } } });
    expect(publishingDisabled.statusCode).toBe(200);
    const upload = multipart(bundle(), auth.csrf);
    const disabledUpload = await app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf, "content-type": upload.contentType }, payload: upload.body });
    expect(disabledUpload.statusCode).toBe(403);
    const publishingEnabled = await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf }, payload: { application_settings: { "publishing.enabled": true } } });
    expect(publishingEnabled.statusCode).toBe(200);
    const anonymous = await app.inject({ method: "POST", url: "/api/publish/bundle", headers: { "content-type": upload.contentType }, payload: upload.body });
    expect(anonymous.statusCode).toBe(401);
    const csrfFailureUpload = multipart(bundle(), undefined);
    const csrfFailure = await app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "content-type": csrfFailureUpload.contentType }, payload: csrfFailureUpload.body });
    expect(csrfFailure.statusCode).toBe(403);
    const submission = await app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf, "content-type": upload.contentType }, payload: upload.body });
    expect(submission.statusCode).toBe(200);
    const submissionBody = JSON.parse(submission.body) as { submission_id: number; status: string };
    expect(submissionBody.status).toBe("pending");
    const id = submissionBody.submission_id;

    const mine = await app.inject({ method: "GET", url: "/api/submissions/mine", headers: { cookie: auth.cookie } });
    expect(mine.statusCode).toBe(200);
    expect((JSON.parse(mine.body) as { submissions: unknown[] }).submissions).toHaveLength(1);
    const queue = await app.inject({ method: "GET", url: "/api/submissions", headers: { cookie: auth.cookie } });
    expect(queue.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/api/submissions/${id}`, headers: { cookie: auth.cookie } });
    expect(detail.statusCode).toBe(200);
    expect((JSON.parse(detail.body) as { submission: { status: string } }).submission.status).toBe("pending");

    const approval = await app.inject({ method: "POST", url: `/api/submissions/${id}/verify`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf }, payload: { metadata: { title: "Canonically Approved" } } });
    expect(approval.statusCode).toBe(200);
    expect((JSON.parse(approval.body) as { submission: { status: string } }).submission.status).toBe("verified");
    const duplicateApproval = await app.inject({ method: "POST", url: `/api/submissions/${id}/verify`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf }, payload: { metadata: {} } });
    expect(duplicateApproval.statusCode).toBe(400);
    const duplicateUpload = await app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf, "content-type": upload.contentType }, payload: upload.body });
    expect(duplicateUpload.statusCode).toBe(400);

    const rejectedUpload = multipart(bundle("org.example.rejected"), auth.csrf);
    const rejectedSubmission = await app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf, "content-type": rejectedUpload.contentType }, payload: rejectedUpload.body });
    const rejectedId = (JSON.parse(rejectedSubmission.body) as { submission_id: number }).submission_id;
    const rejection = await app.inject({ method: "POST", url: `/api/submissions/${rejectedId}/reject`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf } });
    expect(rejection.statusCode).toBe(200);
    expect((JSON.parse(rejection.body) as { submission: { status: string } }).submission.status).toBe("rejected");
    expect(fs.existsSync(path.join(fixture.targetRoot, "storage", "staging", "submissions", String(rejectedId)))).toBe(true);

    const catalog = await app.inject({ method: "GET", url: "/api/games/org.example.canonical" });
    expect(catalog.statusCode).toBe(200);
    const game = (JSON.parse(catalog.body) as { game: { title: string; architectures: string[] } }).game;
    expect(game.title).toBe("Canonically Approved");
    expect(game.architectures).toEqual(["qemu"]);
    const download = await app.inject({ method: "GET", url: "/api/games/org.example.canonical/download?architecture=qemu" });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.length).toBeGreaterThan(72);
    const icon = await app.inject({ method: "GET", url: "/api/games/org.example.canonical/icon?architecture=qemu" });
    expect(icon.statusCode).toBe(200);
    expect(icon.rawPayload).toEqual(PNG);

    const canonicalDb = new Database(path.join(fixture.targetRoot, "store.sqlite"), { readonly: true, fileMustExist: true });
    expect(canonicalDb.prepare("SELECT status FROM submissions WHERE submission_id = ?").get(id)).toEqual({ status: "published" });
    const operation = canonicalDb.prepare("SELECT state, completed_at FROM publication_operations WHERE submission_id = ?").get(id) as { state: string; completed_at: string | null };
    expect(operation.state).toBe("completed");
    expect(operation.completed_at).toEqual(expect.any(String));
    expect((canonicalDb.prepare("SELECT COUNT(*) AS count FROM review_decisions WHERE submission_id = ? AND decision = 'approved'").get(id) as { count: number }).count).toBe(1);
    canonicalDb.close();
    expect(fs.existsSync(path.join(fixture.targetRoot, "index.json"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.targetRoot, "cartridges"))).toBe(false);
    await app.close();
  }, 60_000);

  it("recovers a durable canonical publication after a deterministic pre-promotion interruption", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const config = loadConfig(environment(fixture));
    const app = buildApp({ config, logger: false });
    const auth = await authenticate(app);
    const upload = multipart(bundle("org.example.recovery"), auth.csrf);
    const submission = await app.inject({ method: "POST", url: "/api/publish/bundle", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf, "content-type": upload.contentType }, payload: upload.body });
    const id = (JSON.parse(submission.body) as { submission_id: number }).submission_id;
    await app.close();

    const interruptedResource = openTargetStorage(fixture.targetRoot, "read-write");
    const interrupted = new CanonicalWorkflowService({ config, root: fixture.targetRoot, database: interruptedResource, fault: (point) => { if (point === "before-object-promotion") throw new Error("deterministic fault"); } });
    const admin = { authenticated: true, id: 8, name: "canonical-admin", username: "canonical-admin", email: "canonical-admin@example.test", role: "admin" as const, groups: ["editors"], authMethod: "session" as const };
    expect(() => interrupted.approve(id, {}, admin)).toThrow("deterministic fault");
    interrupted.close();

    const recoveryResource = openTargetStorage(fixture.targetRoot, "read-write");
    const recovered = new CanonicalWorkflowService({ config, root: fixture.targetRoot, database: recoveryResource });
    recovered.close();
    const verify = new Database(path.join(fixture.targetRoot, "store.sqlite"), { readonly: true, fileMustExist: true });
    expect(verify.prepare("SELECT state FROM publication_operations WHERE submission_id = ?").get(id)).toEqual({ state: "completed" });
    expect(verify.prepare("SELECT status FROM submissions WHERE submission_id = ?").get(id)).toEqual({ status: "published" });
    verify.close();
  }, 60_000);

  it("persists drafts across restart, records notes, and creates immutable rejected revisions", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const config = loadConfig(environment(fixture));
    let app = buildApp({ config, logger: false });
    const auth = await authenticate(app);
    const draft = await app.inject({ method: "POST", url: "/api/drafts", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf }, payload: { metadata: { summary: "saved draft" } } });
    expect(draft.statusCode).toBe(201);
    const draftId = (JSON.parse(draft.body) as { draft: { id: string } }).draft.id;
    const upload = multipart(bundle("org.example.revision"), auth.csrf);
    const attached = await app.inject({ method: "POST", url: `/api/drafts/${draftId}/artifact`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf, "content-type": upload.contentType }, payload: upload.body });
    expect(attached.statusCode).toBe(200);
    await app.close();
    app = buildApp({ config, logger: false });
    const persisted = await app.inject({ method: "GET", url: "/api/drafts", headers: { cookie: auth.cookie } });
    expect(persisted.statusCode).toBe(200);
    expect((JSON.parse(persisted.body) as { drafts: Array<{ id: string; has_artifact: boolean }> }).drafts).toEqual(expect.arrayContaining([expect.objectContaining({ id: draftId, has_artifact: true })]));
    const submitted = await app.inject({ method: "POST", url: `/api/drafts/${draftId}/submit`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf } });
    expect(submitted.statusCode).toBe(200);
    const submissionId = (JSON.parse(submitted.body) as { submission_id: number }).submission_id;
    const rejected = await app.inject({ method: "POST", url: `/api/submissions/${submissionId}/reject`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf }, payload: { note: "Please revise the title." } });
    expect(rejected.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/api/submissions/${submissionId}`, headers: { cookie: auth.cookie } });
    expect((JSON.parse(detail.body) as { submission: { status: string; review_history: Array<{ note: string }> } }).submission).toMatchObject({ status: "rejected", review_history: [expect.objectContaining({ note: "Please revise the title." })] });
    const revision = await app.inject({ method: "POST", url: `/api/submissions/${submissionId}/resubmit`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf } });
    expect(revision.statusCode).toBe(201);
    const revisionId = (JSON.parse(revision.body) as { draft: { id: string; source_submission_id: number } }).draft.id;
    const revisionUpload = multipart(bundle("org.example.revision"), auth.csrf);
    expect((await app.inject({ method: "POST", url: `/api/drafts/${revisionId}/artifact`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf, "content-type": revisionUpload.contentType }, payload: revisionUpload.body })).statusCode).toBe(200);
    const submittedRevision = await app.inject({ method: "POST", url: `/api/drafts/${revisionId}/submit`, headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf } });
    const revisionSubmissionId = (JSON.parse(submittedRevision.body) as { submission_id: number }).submission_id;
    const database = new Database(path.join(fixture.targetRoot, "store.sqlite"), { readonly: true });
    expect(database.prepare("SELECT status, revision_of_submission_id, revision_number FROM submissions WHERE submission_id = ?").get(revisionSubmissionId)).toEqual({ status: "pending_review", revision_of_submission_id: submissionId, revision_number: 2 });
    expect(database.prepare("SELECT status FROM submissions WHERE submission_id = ?").get(submissionId)).toEqual({ status: "rejected" });
    database.close();
    await app.close();
  }, 60_000);

  it("enforces a cross-process-capable filesystem writer lease", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m52g2-lock-"));
    const first = new CanonicalWriterLease(root);
    expect(() => new CanonicalWriterLease(root)).toThrow("canonical writer is already active");
    first.close();
    const second = new CanonicalWriterLease(root);
    second.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps canonical authentication and readiness independent from the legacy shadow database", async () => {
    const fixture = createDisposableCanonicalReadFixture();
  const sourceDatabase = path.join(fixture.sourceRoot, "store.sqlite");
    const unavailableSource = sourceDatabase + ".temporarily-unavailable";
    const app = buildApp({ config: loadConfig(environment(fixture)), logger: false });
    fs.renameSync(sourceDatabase, unavailableSource);
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      const auth = await authenticate(app);
      const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: auth.cookie } });
      expect(me.statusCode).toBe(200);
      expect((JSON.parse(me.body) as { user: { username: string } }).user.username).toBe("canonical-admin");
    } finally {
      fs.renameSync(unavailableSource, sourceDatabase);
      await app.close();
    }
  }, 60_000);

  it("serves canonical administrative catalog reads while the legacy database is unavailable", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const app = buildApp({ config: loadConfig(environment(fixture)), logger: false });
    const auth = await authenticate(app);
  const sourceDatabase = path.join(fixture.sourceRoot, "store.sqlite");
    const unavailableSource = `${sourceDatabase}.temporarily-unavailable`;
    fs.renameSync(sourceDatabase, unavailableSource);
    try {
      const cartridges = await app.inject({ method: "GET", url: "/api/admin/cartridges", headers: { cookie: auth.cookie } });
      expect(cartridges.statusCode).toBe(200);
      expect((JSON.parse(cartridges.body) as { cartridges: Array<{ id: string }> }).cartridges.map((item) => item.id)).toEqual([
        "org.example.alpha",
        "org.example.beta"
      ]);
    } finally {
      fs.renameSync(unavailableSource, sourceDatabase);
      await app.close();
    }
  }, 60_000);

  it("serializes the persisted session lifetime for canonical local authentication", async () => {
    const fixture = createDisposableCanonicalReadFixture();
    const app = buildApp({ config: loadConfig(environment(fixture)), logger: false });
    const auth = await authenticate(app);
    const policy = await app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: auth.cookie, "x-csrftoken": auth.csrf }, payload: { application_settings: { "session.lifetime_seconds": 60 } } });
    expect(policy.statusCode).toBe(200);
    const csrf = await app.inject({ method: "GET", url: "/auth/csrf", headers: { cookie: auth.cookie } });
    const csrfBody = JSON.parse(csrf.body) as { readonly csrf_token: string };
    const login = await app.inject({ method: "POST", url: "/auth/login", headers: { cookie: auth.cookie, "x-csrftoken": csrfBody.csrf_token }, payload: { username: "canonical-admin", password: "long-password-123" } });
    expect(login.statusCode).toBe(200);
    expect(header(login, "set-cookie")).toContain("Max-Age=60");
    await app.close();
  });
});
