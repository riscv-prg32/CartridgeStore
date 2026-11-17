import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { BackendConfig } from "../config/env.js";
import type Database from "better-sqlite3";

export const MAX_AUDIT_RECORD_BYTES = 4096;
export const MAX_AUDIT_FILE_BYTES = 10 * 1024 * 1024;

export interface AuditEvent {
  readonly event_id: string;
  readonly timestamp: string;
  readonly actor_user_id: number;
  readonly target_type: string;
  readonly target_id: string;
  readonly action: string;
  readonly outcome: "attempted" | "committed" | "failed" | "rejected";
  readonly summary?: Record<string, unknown>;
  readonly request_id: string;
}

export class AuditUnavailableError extends Error {
  readonly code = "admin_audit_unavailable";
  readonly statusCode = 503;

  constructor() {
    super("administrative audit storage is unavailable");
    this.name = "AuditUnavailableError";
  }
}

function assertDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new AuditUnavailableError();
    current = parent;
  }
  const stats = fs.lstatSync(current);
  if (!stats.isDirectory()) throw new AuditUnavailableError();
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const finalStats = fs.lstatSync(resolved);
  if (finalStats.isSymbolicLink() || !finalStats.isDirectory()) throw new AuditUnavailableError();
}

function eventId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

export class AdminAuditLog {
  private readonly path: string;
  private readonly database: Database.Database | undefined;

  constructor(config: BackendConfig, database?: Database.Database) {
    const root = config.authDisposableRoot ?? path.join(config.storeDataDirectory, "admin");
    this.path = path.join(root, "admin-audit.jsonl");
    this.database = database;
  }

  ensureReady(): void {
    const directory = path.dirname(this.path);
    assertDirectory(directory);
    if (fs.existsSync(this.path)) {
      const stats = fs.lstatSync(this.path);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_AUDIT_FILE_BYTES) throw new AuditUnavailableError();
    }
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(this.path, flags, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  }

  append(event: Omit<AuditEvent, "event_id" | "timestamp">): AuditEvent {
    this.ensureReady();
    const record: AuditEvent = {
      event_id: eventId(),
      timestamp: new Date().toISOString(),
      ...event
    };
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (line.byteLength > MAX_AUDIT_RECORD_BYTES) throw new AuditUnavailableError();
    const currentSize = fs.statSync(this.path).size;
    if (currentSize + line.byteLength > MAX_AUDIT_FILE_BYTES) throw new AuditUnavailableError();
    const fd = fs.openSync(this.path, fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (this.database) {
      const table = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admin_audit_events'").get();
      if (table) {
        const summary = record.summary ?? {};
        const summaryJson = JSON.stringify(summary);
        if (summaryJson.length > 2048) throw new AuditUnavailableError();
        this.database.prepare(
          `INSERT INTO admin_audit_events(event_id, timestamp, actor_user_id, target_type, target_id, action, outcome, summary_json, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(record.event_id, record.timestamp, record.actor_user_id, record.target_type, record.target_id, record.action, record.outcome, summaryJson, record.request_id);
      }
    }
    return record;
  }

  rejected(actorUserId: number, targetType: string, targetId: string, action: string, requestId: string): void {
    try {
      this.append({ actor_user_id: actorUserId, target_type: targetType, target_id: targetId, action, outcome: "rejected", request_id: requestId });
    } catch {
      // A rejected operation has not changed SQLite state; preserving the
      // security decision is more important than turning it into a new error.
    }
  }
}
