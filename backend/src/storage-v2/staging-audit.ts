import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { MAX_OBJECT_BYTES } from "./objects.js";
import type { StoragePaths } from "./types.js";

const MAX_STAGING_ENTRIES = 2_000;

export interface StagingAuditFinding {
  readonly code: "orphaned_directory" | "missing_artifact" | "unexpected_entry" | "unsafe_entry" | "artifact_mismatch" | "scan_limit";
  readonly relativePath: string;
  readonly detail: string;
}

export interface StagingAuditReport {
  readonly ok: boolean;
  readonly checkedSubmissions: number;
  readonly checkedArtifacts: number;
  readonly totalBytes: number;
  readonly findings: readonly StagingAuditFinding[];
}

interface StagingRow {
  readonly submission_id: number;
  readonly staging_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

function relativeToRoot(paths: StoragePaths, value: string): string {
  return path.relative(paths.root, value).split(path.sep).join("/");
}

function safeStagingPath(paths: StoragePaths, stagingKey: string): string | null {
  const prefix = "storage/staging/submissions/";
  if (!stagingKey.startsWith(prefix) || stagingKey.includes("\\") || stagingKey.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const candidate = path.resolve(paths.root, stagingKey);
  const root = path.resolve(paths.root);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_OBJECT_BYTES) throw new Error("staged artifact exceeds the configured size limit");
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Read-only audit of private submission staging. Ambiguous or orphaned bytes
 * are never removed: callers must fail closed and preserve the evidence.
 */
export function auditSubmissionStaging(database: Database.Database, paths: StoragePaths): StagingAuditReport {
  const findings: StagingAuditFinding[] = [];
  const expected = new Map<string, StagingRow>();
  // Promoted and quarantined submissions have deliberately left the private
  // staging namespace. Only recoverable staged bytes must still be present.
  const rows = database.prepare("SELECT submission_id, staging_key, sha256, size_bytes FROM submission_artifacts WHERE validation_state IN ('staged', 'validated') ORDER BY submission_artifact_id").all() as StagingRow[];
  let totalBytes = 0;
  for (const row of rows) {
    const keyParts = row.staging_key.split("/");
    if (keyParts.length !== 6 || keyParts[0] !== "storage" || keyParts[1] !== "staging" || keyParts[2] !== "submissions" || keyParts[3] !== String(row.submission_id) || keyParts[4] !== "artifacts" || !/^(esp32c6|qemu)\.prg32$/u.test(keyParts[5] ?? "")) {
      findings.push({ code: "unsafe_entry", relativePath: row.staging_key, detail: "database staging key does not match the canonical private layout" });
      continue;
    }
    const target = safeStagingPath(paths, row.staging_key);
    if (target === null) {
      findings.push({ code: "unsafe_entry", relativePath: row.staging_key, detail: "database staging key is outside the private staging namespace" });
      continue;
    }
    expected.set(target, row);
  }

  if (!fs.existsSync(paths.submissionStagingRoot)) {
    return { ok: expected.size === 0, checkedSubmissions: 0, checkedArtifacts: 0, totalBytes: 0, findings: expected.size === 0 ? [] : [{ code: "missing_artifact", relativePath: "storage/staging/submissions", detail: "private staging root is missing" }] };
  }

  const entries = fs.readdirSync(paths.submissionStagingRoot, { withFileTypes: true });
  if (entries.length > MAX_STAGING_ENTRIES) findings.push({ code: "scan_limit", relativePath: relativeToRoot(paths, paths.submissionStagingRoot), detail: "private staging entry limit exceeded" });
  const seen = new Set<string>();
  let checkedSubmissions = 0;
  for (const entry of entries.slice(0, MAX_STAGING_ENTRIES)) {
    const submissionPath = path.join(paths.submissionStagingRoot, entry.name);
    const relativePath = relativeToRoot(paths, submissionPath);
    if (entry.isSymbolicLink() || !entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      findings.push({ code: "unsafe_entry", relativePath, detail: "private staging contains an unexpected or unsafe submission entry" });
      continue;
    }
    checkedSubmissions += 1;
    const submissionPrefix = `${paths.submissionStagingRoot}${path.sep}${entry.name}${path.sep}`;
    if (![...expected.keys()].some((filePath) => filePath.startsWith(submissionPrefix))) {
      findings.push({ code: "orphaned_directory", relativePath, detail: "private staging directory has no matching submission artifact rows" });
    }
    const descendants: string[] = [];
    const visit = (directory: string): void => {
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        const childPath = path.join(directory, child.name);
        if (child.isSymbolicLink()) {
          findings.push({ code: "unsafe_entry", relativePath: relativeToRoot(paths, childPath), detail: "private staging contains a symlink" });
        } else if (child.isDirectory()) {
          visit(childPath);
        } else if (child.isFile()) {
          descendants.push(childPath);
        } else {
          findings.push({ code: "unsafe_entry", relativePath: relativeToRoot(paths, childPath), detail: "private staging contains an unsupported filesystem entry" });
        }
      }
    };
    visit(submissionPath);
    for (const filePath of descendants) {
      if (seen.size >= MAX_STAGING_ENTRIES) {
        findings.push({ code: "scan_limit", relativePath: relativeToRoot(paths, filePath), detail: "private staging file limit exceeded" });
        break;
      }
      seen.add(filePath);
      const row = expected.get(filePath);
      if (!row) {
        findings.push({ code: "unexpected_entry", relativePath: relativeToRoot(paths, filePath), detail: "staging bytes have no matching database artifact" });
        continue;
      }
      const stat = fs.statSync(filePath);
      totalBytes += stat.size;
      if (stat.size !== row.size_bytes || stat.size > MAX_OBJECT_BYTES || hashFile(filePath) !== row.sha256) {
        findings.push({ code: "artifact_mismatch", relativePath: relativeToRoot(paths, filePath), detail: "staging bytes do not match the recorded size or SHA-256" });
      }
    }
  }

  for (const [filePath] of expected) {
    if (!seen.has(filePath)) findings.push({ code: "missing_artifact", relativePath: relativeToRoot(paths, filePath), detail: "database references staging bytes that are not present" });
  }
  return { ok: findings.length === 0, checkedSubmissions, checkedArtifacts: expected.size, totalBytes, findings };
}

export function assertSubmissionStagingSafe(database: Database.Database, paths: StoragePaths): StagingAuditReport {
  const report = auditSubmissionStaging(database, paths);
  if (!report.ok) {
    throw new Error(`canonical submission staging requires recovery (${report.findings.map((finding) => finding.code).join(",")})`);
  }
  return report;
}
