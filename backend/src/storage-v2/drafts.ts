import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

import type { Principal } from "../auth/principal.js";
import type { BackendConfig } from "../config/env.js";
import { ReviewError } from "../review/errors.js";
import { parseZipArchive } from "../submission/zip.js";
import { prepareSubmissionBundle } from "../submission/service.js";
import type { StoragePaths } from "./types.js";
import type { CanonicalWorkflowService } from "./workflow.js";

export type DraftStatus = "draft" | "submitting" | "submitted" | "abandoned";
export interface DraftRecord {
  readonly id: string;
  readonly status: DraftStatus;
  readonly metadata: Record<string, unknown>;
  readonly has_artifact: boolean;
  readonly source_submission_id: number | null;
  readonly submitted_submission_id: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly submitted_at: string | null;
}

function now(): string { return new Date().toISOString(); }
function json(value: unknown): string { return JSON.stringify(value); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ReviewError("draft metadata must be an object");
  return value as Record<string, unknown>;
}

export class CanonicalDraftService {
  private readonly draftRoot: string;
  constructor(private readonly database: Database.Database, private readonly paths: StoragePaths, private readonly config: BackendConfig, private readonly workflow: CanonicalWorkflowService) {
    this.draftRoot = path.join(paths.stagingRoot, "drafts");
    fs.mkdirSync(this.draftRoot, { recursive: true, mode: 0o700 });
    this.database.prepare("UPDATE publisher_drafts SET status = 'draft', updated_at = ? WHERE status = 'submitting'").run(now());
  }

  create(userId: number, metadata: unknown = {}, sourceSubmissionId: number | null = null): DraftRecord {
    const parsed = object(metadata);
    const id = `draft_${crypto.randomUUID()}`;
    const timestamp = now();
    if (sourceSubmissionId !== null) {
      const source = this.database.prepare("SELECT submitted_by_user_id, status, (SELECT metadata_json FROM submission_artifacts WHERE submission_id = submissions.submission_id ORDER BY architecture LIMIT 1) AS metadata_json FROM submissions WHERE submission_id = ?").get(sourceSubmissionId) as { submitted_by_user_id: number; status: string; metadata_json: string | null } | undefined;
      if (!source || source.submitted_by_user_id !== userId || source.status !== "rejected") throw new ReviewError("only an owned rejected submission can be revised", "review_not_authorized", 403);
      const sourceMetadata = source.metadata_json ? JSON.parse(source.metadata_json) as Record<string, unknown> : {};
      Object.assign(sourceMetadata, parsed);
      Object.assign(parsed, sourceMetadata);
    }
    this.database.prepare("INSERT INTO publisher_drafts(draft_id, user_id, status, metadata_json, source_submission_id, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)").run(id, userId, json(parsed), sourceSubmissionId, timestamp, timestamp);
    return this.detail(userId, id);
  }

  list(userId: number): DraftRecord[] {
    return (this.database.prepare("SELECT * FROM publisher_drafts WHERE user_id = ? AND status <> 'abandoned' ORDER BY updated_at DESC, draft_id DESC").all(userId) as DraftRow[]).map((row) => this.map(row));
  }

  detail(userId: number, id: string): DraftRecord {
    const row = this.row(userId, id);
    if (!row) throw new ReviewError("draft not found", "review_not_found", 404);
    return this.map(row);
  }

  update(userId: number, id: string, metadata: unknown): DraftRecord {
    const row = this.requireDraft(userId, id);
    const parsed = object(metadata);
    this.database.prepare("UPDATE publisher_drafts SET metadata_json = ?, updated_at = ? WHERE draft_id = ? AND user_id = ? AND status = 'draft'").run(json(parsed), now(), id, userId);
    return this.detail(userId, row.draft_id);
  }

  delete(userId: number, id: string): void {
    const row = this.requireDraft(userId, id);
    this.database.prepare("UPDATE publisher_drafts SET status = 'abandoned', updated_at = ? WHERE draft_id = ? AND user_id = ? AND status = 'draft'").run(now(), id, userId);
    if (row.bundle_path) fs.rmSync(this.absolute(row.bundle_path), { force: true });
  }

  attach(userId: number, id: string, bundle: Uint8Array): DraftRecord {
    const row = this.requireDraft(userId, id);
    if (bundle.byteLength > this.config.submissionMaxArchiveBytes) throw new ReviewError("bundle upload is too large", "review_invalid_request", 413);
    const entries = parseZipArchive(bundle, this.config);
    prepareSubmissionBundle(entries, this.config);
    const relative = `storage/staging/drafts/${id}.zip`;
    const target = this.absolute(relative);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, bundle, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
    this.database.prepare("UPDATE publisher_drafts SET bundle_path = ?, updated_at = ? WHERE draft_id = ? AND user_id = ? AND status = 'draft'").run(relative, now(), id, userId);
    return this.detail(userId, row.draft_id);
  }

  submit(userId: number, id: string): Record<string, unknown> {
    const row = this.requireDraft(userId, id);
    if (!row.bundle_path) throw new ReviewError("a validated cartridge bundle is required");
    const claimed = this.database.prepare("UPDATE publisher_drafts SET status = 'submitting', updated_at = ? WHERE draft_id = ? AND user_id = ? AND status = 'draft'").run(now(), id, userId).changes;
    if (claimed !== 1) throw new ReviewError("draft has changed state", "review_state_conflict", 409);
    try {
      const principal = this.principal(userId);
      const result = this.workflow.createFromBundle(fs.readFileSync(this.absolute(row.bundle_path)), principal, row.source_submission_id);
      this.database.prepare("UPDATE publisher_drafts SET status = 'submitted', submitted_submission_id = ?, submitted_at = ?, updated_at = ? WHERE draft_id = ? AND user_id = ?").run(result.submission_id, now(), now(), id, userId);
      return { ...result, draft_id: id };
    } catch (error) {
      this.database.prepare("UPDATE publisher_drafts SET status = 'draft', updated_at = ? WHERE draft_id = ? AND user_id = ? AND status = 'submitting'").run(now(), id, userId);
      throw error;
    }
  }

  private principal(userId: number): Principal {
    const row = this.database.prepare("SELECT username, email, role FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as { username: string; email: string; role: string } | undefined;
    if (!row) throw new ReviewError("account is unavailable", "review_not_authorized", 403);
    return { authenticated: true, id: userId, name: row.username, username: row.username, email: row.email, role: row.role as Principal["role"], groups: [], authMethod: "session" };
  }

  private requireDraft(userId: number, id: string): DraftRow { const row = this.row(userId, id); if (!row) throw new ReviewError("draft not found", "review_not_found", 404); if (row.status !== "draft") throw new ReviewError("draft is no longer editable", "review_state_conflict", 409); return row; }
  private row(userId: number, id: string): DraftRow | undefined { return this.database.prepare("SELECT * FROM publisher_drafts WHERE draft_id = ? AND user_id = ?").get(id, userId) as DraftRow | undefined; }
  private absolute(relative: string): string { const target = path.resolve(this.paths.root, relative); if (!target.startsWith(`${path.resolve(this.paths.root)}${path.sep}`)) throw new ReviewError("draft storage path is unsafe", "review_operation_failed", 500); return target; }
  private map(row: DraftRow): DraftRecord { return { id: row.draft_id, status: row.status as DraftStatus, metadata: JSON.parse(row.metadata_json) as Record<string, unknown>, has_artifact: Boolean(row.bundle_path && fs.existsSync(this.absolute(row.bundle_path))), source_submission_id: row.source_submission_id, submitted_submission_id: row.submitted_submission_id, created_at: row.created_at, updated_at: row.updated_at, submitted_at: row.submitted_at }; }
}

interface DraftRow { draft_id: string; user_id: number; status: string; metadata_json: string; bundle_path: string | null; source_submission_id: number | null; submitted_submission_id: number | null; created_at: string; updated_at: string; submitted_at: string | null; }
