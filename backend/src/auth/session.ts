import crypto from "node:crypto";

import type Database from "better-sqlite3";

export interface SessionRecord {
  readonly id: string;
  readonly userId: number | null;
  readonly csrfToken: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly reauthenticatedAt: number | null;
}

export interface SessionCookieOptions {
  readonly name: string;
  readonly secure: boolean;
  readonly sameSite: "lax" | "strict" | "none";
  readonly domain: string | undefined;
  readonly maxAgeSeconds: number;
}

const SESSION_CIPHER_PREFIX = "prg32session:v1:";

function idHash(secret: string, id: string): string {
  return crypto.createHmac("sha256", secret).update("session-id:" + id, "utf8").digest("hex");
}

function sessionKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from("prg32-cartridge-store/session-csrf/v1", "utf8"),
    Buffer.from("auth-session-csrf", "utf8"),
    32
  ));
}

function protectCsrf(secret: string, value: string): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey(secret), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SESSION_CIPHER_PREFIX + Buffer.from(JSON.stringify({
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url")
  }), "utf8").toString("base64url");
}

function recoverCsrf(secret: string, encoded: string): string | null {
  try {
    if (!encoded.startsWith(SESSION_CIPHER_PREFIX)) return null;
    const record = JSON.parse(Buffer.from(encoded.slice(SESSION_CIPHER_PREFIX.length), "base64url").toString("utf8")) as {
      nonce?: string; ciphertext?: string; tag?: string
    };
    if (typeof record.nonce !== "string" || typeof record.ciphertext !== "string" || typeof record.tag !== "string") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey(secret), Buffer.from(record.nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly secret: string,
    private readonly lifetimeSeconds: number | (() => number),
    private readonly database?: Database.Database
  ) {}

  issue(userId: number | null, now = Date.now()): { readonly record: SessionRecord; readonly cookieValue: string } {
    const id = crypto.randomBytes(32).toString("base64url");
    const record: SessionRecord = {
      id,
      userId,
      csrfToken: crypto.randomBytes(32).toString("base64url"),
      createdAt: now,
      expiresAt: now + (typeof this.lifetimeSeconds === "function" ? this.lifetimeSeconds() : this.lifetimeSeconds) * 1000,
      reauthenticatedAt: null
    };
    if (this.database) {
      this.database.prepare(
        "INSERT INTO auth_sessions(id_hash, user_id, csrf_token_ciphertext, created_at, expires_at, reauthenticated_at) VALUES (?, ?, ?, ?, ?, NULL)"
      ).run(idHash(this.secret, id), userId, protectCsrf(this.secret, record.csrfToken), record.createdAt, record.expiresAt);
    } else {
      this.sessions.set(id, record);
    }
    return { record, cookieValue: this.sign(id) };
  }

  get(cookieValue: string | undefined, now = Date.now()): SessionRecord | null {
    const id = this.verify(cookieValue);
    if (!id) return null;
    if (!this.database) {
      const record = this.sessions.get(id);
      if (!record || record.expiresAt <= now) {
        if (record) this.sessions.delete(id);
        return null;
      }
      return record;
    }
    const hash = idHash(this.secret, id);
    const row = this.database.prepare(
      "SELECT user_id, csrf_token_ciphertext, created_at, expires_at, reauthenticated_at FROM auth_sessions WHERE id_hash = ?"
    ).get(hash) as {
      user_id: number | null; csrf_token_ciphertext: string; created_at: number; expires_at: number; reauthenticated_at: number | null
    } | undefined;
    if (!row || row.expires_at <= now) {
      if (row) this.database.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(hash);
      return null;
    }
    const csrfToken = recoverCsrf(this.secret, row.csrf_token_ciphertext);
    if (!csrfToken) {
      this.database.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(hash);
      return null;
    }
    return { id, userId: row.user_id, csrfToken, createdAt: row.created_at, expiresAt: row.expires_at, reauthenticatedAt: row.reauthenticated_at ?? null };
  }

  recordRecentReauthentication(record: SessionRecord, at = Date.now()): SessionRecord {
    if (this.database) {
      this.database.prepare("UPDATE auth_sessions SET reauthenticated_at = ? WHERE id_hash = ?").run(at, idHash(this.secret, record.id));
    } else {
      const current = this.sessions.get(record.id);
      if (current) this.sessions.set(record.id, { ...current, reauthenticatedAt: at });
    }
    return { ...record, reauthenticatedAt: at };
  }

  rotate(old: SessionRecord | null, userId: number, now = Date.now()): { readonly record: SessionRecord; readonly cookieValue: string } {
    if (!this.database) {
      if (old) this.sessions.delete(old.id);
      return this.issue(userId, now);
    }
    if (this.database.inTransaction) {
      if (old) this.database.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(idHash(this.secret, old.id));
      return this.issue(userId, now);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (old) this.database.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(idHash(this.secret, old.id));
      const issued = this.issue(userId, now);
      this.database.exec("COMMIT");
      return issued;
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  invalidate(record: SessionRecord | null): void {
    if (!record) return;
    if (this.database) this.database.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(idHash(this.secret, record.id));
    else this.sessions.delete(record.id);
  }

  invalidateUser(userId: number): void {
    if (this.database) this.database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    else for (const [id, record] of this.sessions) if (record.userId === userId) this.sessions.delete(id);
  }

  clear(): void {
    if (this.database) this.database.exec("DELETE FROM auth_sessions");
    else this.sessions.clear();
  }

  private sign(id: string): string {
    const payload = "v1." + id;
    const signature = crypto.createHmac("sha256", this.secret).update(payload).digest("base64url");
    return payload + "." + signature;
  }

  private verify(cookieValue: string | undefined): string | null {
    if (!cookieValue) return null;
    const parts = cookieValue.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
    const id = parts[1];
    const signature = parts[2];
    const expected = crypto.createHmac("sha256", this.secret).update("v1." + id).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    return id;
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of (header ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const rawValue = item.slice(separator + 1).trim();
    if (!name || rawValue.length > 8192) continue;
    try {
      result.set(name, decodeURIComponent(rawValue));
    } catch {
      // Malformed cookie values are untrusted input, not server errors.
    }
  }
  return result;
}

export function serializeSessionCookie(options: SessionCookieOptions, value: string, expires = false): string {
  const attributes = [
    options.name + "=" + encodeURIComponent(value),
    "Path=/",
    "HttpOnly",
    "SameSite=" + options.sameSite.charAt(0).toUpperCase() + options.sameSite.slice(1)
  ];
  if (options.domain) attributes.push("Domain=" + options.domain);
  if (options.secure) attributes.push("Secure");
  if (expires) attributes.push("Max-Age=0");
  else attributes.push("Max-Age=" + options.maxAgeSeconds);
  return attributes.join("; ");
}
