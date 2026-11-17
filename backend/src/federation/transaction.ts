import crypto from "node:crypto";

import type Database from "better-sqlite3";

import type { FederationProviderService, FederationProtocol } from "./provider.js";

export interface FederationTransactionInput {
  readonly protocol: FederationProtocol;
  readonly providerId: string;
  readonly callbackBinding: string;
  readonly state: string;
  readonly nonce?: string;
  readonly pkceVerifier?: string;
  readonly requestId?: string;
  readonly returnPath: string;
  readonly now?: number;
  readonly ttlSeconds?: number;
}

export interface ConsumedFederationTransaction {
  readonly transactionId: string;
  readonly protocol: FederationProtocol;
  readonly providerId: string;
  readonly callbackBinding: string;
  readonly nonceHash: string | null;
  readonly nonce: string | null;
  readonly pkceVerifier: string | null;
  readonly requestId: string | null;
  readonly returnPath: string;
  readonly providerGeneration: number;
}

export interface PendingFederationTransaction {
  readonly transactionId: string;
  readonly protocol: FederationProtocol;
  readonly providerId: string;
  readonly callbackBinding: string;
  readonly stateHash: string;
  readonly requestId: string | null;
  readonly returnPath: string;
  readonly expiresAt: number;
  readonly providerGeneration: number;
}

export class FederationTransactionError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
    this.name = "FederationTransactionError";
  }
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function protect(secret: string, providerId: string, purpose: string, value: string): string {
  const nonce = crypto.randomBytes(12);
  const key = Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from("prg32-cartridge-store/federation-transaction/v1", "utf8"),
    Buffer.from(providerId, "utf8"),
    32
  ));
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(purpose + ":" + providerId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return "prg32txn:v1:" + Buffer.from(JSON.stringify({
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  }), "utf8").toString("base64url");
}

function recover(secret: string, providerId: string, purpose: string, encoded: string): string | null {
  try {
    if (!encoded.startsWith("prg32txn:v1:")) return null;
    const value = JSON.parse(Buffer.from(encoded.slice("prg32txn:v1:".length), "base64url").toString("utf8")) as {
      nonce?: string; ciphertext?: string; tag?: string
    };
    if (typeof value.nonce !== "string" || typeof value.ciphertext !== "string" || typeof value.tag !== "string") return null;
    const key = Buffer.from(crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("prg32-cartridge-store/federation-transaction/v1", "utf8"),
      Buffer.from(providerId, "utf8"),
      32
    ));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64url"));
    decipher.setAAD(Buffer.from(purpose + ":" + providerId, "utf8"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export class FederationTransactionStore {
  constructor(
    private readonly database: Database.Database,
    private readonly secret: string,
    private readonly providers: FederationProviderService
  ) {
    if (secret.length < 32) throw new FederationTransactionError("federation_secret_invalid", 500, "federation transaction protection is unavailable");
  }

  create(input: FederationTransactionInput): { readonly transactionId: string; readonly state: string } {
    const provider = this.providers.enabled(input.providerId, input.protocol);
    if (input.callbackBinding.length < 1 || input.callbackBinding.length > 160) throw new FederationTransactionError("federation_transaction_invalid", 400, "callback binding is invalid");
    if (input.returnPath.length < 1 || input.returnPath.length > 512 || !input.returnPath.startsWith("/") || input.returnPath.startsWith("//")) {
      throw new FederationTransactionError("federation_transaction_invalid", 400, "return path is invalid");
    }
    if (input.state.length < 32 || input.state.length > 256) throw new FederationTransactionError("federation_transaction_invalid", 400, "state is invalid");
    const now = input.now ?? Date.now();
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new FederationTransactionError("federation_transaction_invalid", 400, "transaction lifetime is invalid");
    const transactionId = crypto.randomBytes(32).toString("base64url");
    const requestId = input.requestId ?? null;
    if (requestId !== null && (requestId.length < 1 || requestId.length > 512)) throw new FederationTransactionError("federation_transaction_invalid", 400, "request identifier is invalid");
    try {
      this.database.prepare(
        "INSERT INTO federation_transactions(transaction_id, protocol, provider_id, callback_binding, state_hash, nonce_hash, nonce_ciphertext, pkce_verifier_ciphertext, request_id, return_path, created_at, expires_at, provider_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        transactionId, provider.protocol, provider.providerId, input.callbackBinding, digest(input.state),
        input.nonce === undefined ? null : digest(input.nonce),
        input.nonce === undefined ? null : protect(this.secret, provider.providerId, "oidc-nonce", input.nonce),
        input.pkceVerifier === undefined ? null : protect(this.secret, provider.providerId, "pkce-verifier", input.pkceVerifier),
        requestId, input.returnPath, now, now + ttlSeconds * 1000, provider.generation
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) {
        throw new FederationTransactionError("federation_transaction_conflict", 409, "federation transaction conflicts with an existing record");
      }
      throw error;
    }
    return { transactionId, state: input.state };
  }

  consume(input: { readonly transactionId: string; readonly state: string; readonly protocol: FederationProtocol; readonly providerId: string; readonly callbackBinding: string; readonly now?: number }): ConsumedFederationTransaction {
    const now = input.now ?? Date.now();
    this.providers.get(input.providerId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT transaction_id, protocol, provider_id, callback_binding, state_hash, nonce_hash, nonce_ciphertext, pkce_verifier_ciphertext, request_id, return_path, expires_at, consumed_at, provider_generation FROM federation_transactions WHERE transaction_id = ?"
      ).get(input.transactionId) as {
        transaction_id: string; protocol: FederationProtocol; provider_id: string; callback_binding: string; state_hash: string; nonce_hash: string | null; nonce_ciphertext: string | null; pkce_verifier_ciphertext: string | null; request_id: string | null; return_path: string; expires_at: number; consumed_at: number | null; provider_generation: number
      } | undefined;
      if (!row || row.protocol !== input.protocol || row.provider_id !== input.providerId || row.callback_binding !== input.callbackBinding || row.state_hash !== digest(input.state)) {
        throw new FederationTransactionError("federation_transaction_invalid", 400, "federation transaction is invalid");
      }
      if (row.consumed_at !== null) throw new FederationTransactionError("federation_transaction_replayed", 409, "federation transaction was already consumed");
      if (row.expires_at <= now) throw new FederationTransactionError("federation_transaction_expired", 400, "federation transaction has expired");
      const provider = this.providers.get(row.provider_id);
      if (!provider.enabled || provider.generation !== row.provider_generation) throw new FederationTransactionError("federation_transaction_revoked", 409, "federation transaction was revoked");
      const changed = this.database.prepare(
        "UPDATE federation_transactions SET consumed_at = ? WHERE transaction_id = ? AND consumed_at IS NULL"
      ).run(now, row.transaction_id).changes;
      if (changed !== 1) throw new FederationTransactionError("federation_transaction_replayed", 409, "federation transaction was already consumed");
      this.database.exec("COMMIT");
      const nonce = row.nonce_ciphertext === null ? null : recover(this.secret, row.provider_id, "oidc-nonce", row.nonce_ciphertext);
      const pkceVerifier = row.pkce_verifier_ciphertext === null ? null : recover(this.secret, row.provider_id, "pkce-verifier", row.pkce_verifier_ciphertext);
      if (row.nonce_ciphertext !== null && nonce === null) throw new FederationTransactionError("federation_transaction_protected_value_invalid", 500, "federation transaction protection failed");
      if (row.pkce_verifier_ciphertext !== null && pkceVerifier === null) throw new FederationTransactionError("federation_transaction_protected_value_invalid", 500, "federation transaction protection failed");
      return {
        transactionId: row.transaction_id,
        protocol: row.protocol,
        providerId: row.provider_id,
        callbackBinding: row.callback_binding,
        nonceHash: row.nonce_hash,
        nonce,
        pkceVerifier,
        requestId: row.request_id,
        returnPath: row.return_path,
        providerGeneration: row.provider_generation
      };
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  pending(transactionId: string): PendingFederationTransaction | null {
    const row = this.database.prepare(
      "SELECT transaction_id, protocol, provider_id, callback_binding, state_hash, request_id, return_path, expires_at, consumed_at, provider_generation FROM federation_transactions WHERE transaction_id = ?"
    ).get(transactionId) as {
      transaction_id: string; protocol: FederationProtocol; provider_id: string; callback_binding: string; state_hash: string;
      request_id: string | null; return_path: string; expires_at: number; consumed_at: number | null; provider_generation: number
    } | undefined;
    if (!row || row.consumed_at !== null) return null;
    return {
      transactionId: row.transaction_id,
      protocol: row.protocol,
      providerId: row.provider_id,
      callbackBinding: row.callback_binding,
      stateHash: row.state_hash,
      requestId: row.request_id,
      returnPath: row.return_path,
      expiresAt: row.expires_at,
      providerGeneration: row.provider_generation
    };
  }

  wasConsumed(transactionId: string): boolean {
    const row = this.database.prepare("SELECT consumed_at FROM federation_transactions WHERE transaction_id = ?").get(transactionId) as { consumed_at: number | null } | undefined;
    return row?.consumed_at !== null && row?.consumed_at !== undefined;
  }

  isRequestPending(input: { readonly protocol: FederationProtocol; readonly providerId: string; readonly requestId: string; readonly now?: number }): boolean {
    const now = input.now ?? Date.now();
    const row = this.database.prepare(
      "SELECT 1 AS present FROM federation_transactions WHERE protocol = ? AND provider_id = ? AND request_id = ? AND consumed_at IS NULL AND expires_at > ?"
    ).get(input.protocol, input.providerId, input.requestId, now) as { present?: number } | undefined;
    return row?.present === 1;
  }

  consumeByRequestId(input: {
    readonly protocol: FederationProtocol;
    readonly providerId: string;
    readonly requestId: string;
    readonly state: string;
    readonly callbackBinding: string;
    readonly now?: number;
  }): ConsumedFederationTransaction {
    const now = input.now ?? Date.now();
    this.providers.get(input.providerId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT transaction_id, protocol, provider_id, callback_binding, state_hash, nonce_hash, nonce_ciphertext, pkce_verifier_ciphertext, request_id, return_path, expires_at, consumed_at, provider_generation FROM federation_transactions WHERE protocol = ? AND provider_id = ? AND request_id = ?"
      ).get(input.protocol, input.providerId, input.requestId) as {
        transaction_id: string; protocol: FederationProtocol; provider_id: string; callback_binding: string; state_hash: string;
        nonce_hash: string | null; nonce_ciphertext: string | null; pkce_verifier_ciphertext: string | null; request_id: string | null;
        return_path: string; expires_at: number; consumed_at: number | null; provider_generation: number
      } | undefined;
      if (!row || row.callback_binding !== input.callbackBinding || row.state_hash !== digest(input.state)) {
        throw new FederationTransactionError("federation_transaction_invalid", 400, "federation transaction is invalid");
      }
      if (row.consumed_at !== null) throw new FederationTransactionError("federation_transaction_replayed", 409, "federation transaction was already consumed");
      if (row.expires_at <= now) throw new FederationTransactionError("federation_transaction_expired", 400, "federation transaction has expired");
      const provider = this.providers.get(row.provider_id);
      if (!provider.enabled || provider.generation !== row.provider_generation) throw new FederationTransactionError("federation_transaction_revoked", 409, "federation transaction was revoked");
      if (this.database.prepare("UPDATE federation_transactions SET consumed_at = ? WHERE transaction_id = ? AND consumed_at IS NULL").run(now, row.transaction_id).changes !== 1) {
        throw new FederationTransactionError("federation_transaction_replayed", 409, "federation transaction was already consumed");
      }
      this.database.exec("COMMIT");
      const nonce = row.nonce_ciphertext === null ? null : recover(this.secret, row.provider_id, "oidc-nonce", row.nonce_ciphertext);
      const pkceVerifier = row.pkce_verifier_ciphertext === null ? null : recover(this.secret, row.provider_id, "pkce-verifier", row.pkce_verifier_ciphertext);
      if (row.nonce_ciphertext !== null && nonce === null) throw new FederationTransactionError("federation_transaction_protected_value_invalid", 500, "federation transaction protection failed");
      if (row.pkce_verifier_ciphertext !== null && pkceVerifier === null) throw new FederationTransactionError("federation_transaction_protected_value_invalid", 500, "federation transaction protection failed");
      return { transactionId: row.transaction_id, protocol: row.protocol, providerId: row.provider_id, callbackBinding: row.callback_binding, nonceHash: row.nonce_hash, nonce, pkceVerifier, requestId: row.request_id, returnPath: row.return_path, providerGeneration: row.provider_generation };
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  revokePending(providerId: string, now = Date.now()): number {
    this.providers.get(providerId);
    return this.database.prepare("UPDATE federation_transactions SET consumed_at = ? WHERE provider_id = ? AND consumed_at IS NULL")
      .run(now, providerId).changes;
  }

  recordReplays(protocol: FederationProtocol, providerId: string, identifiers: readonly string[], now = Date.now(), ttlSeconds = 900): void {
    if (identifiers.length < 1 || identifiers.length > 4) throw new FederationTransactionError("federation_replay_invalid", 400, "replay identifiers are invalid");
    const unique = [...new Set(identifiers)];
    if (unique.some((identifier) => identifier.length < 1 || identifier.length > 512)) throw new FederationTransactionError("federation_replay_invalid", 400, "replay identifier is invalid");
    this.providers.get(providerId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.database.prepare("INSERT INTO federation_replays(protocol, provider_id, identifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)");
      for (const identifier of unique) insert.run(protocol, providerId, identifier, now, now + ttlSeconds * 1000);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) {
        throw new FederationTransactionError("federation_transaction_replayed", 409, "replay identifier was already used");
      }
      throw error;
    }
  }

  recordReplay(protocol: FederationProtocol, providerId: string, identifier: string, now = Date.now(), ttlSeconds = 900): void {
    this.providers.get(providerId);
    if (identifier.length < 1 || identifier.length > 512 || !Number.isSafeInteger(now) || ttlSeconds < 1 || ttlSeconds > 86400) {
      throw new FederationTransactionError("federation_replay_invalid", 400, "replay identifier is invalid");
    }
    try {
      this.database.prepare(
        "INSERT INTO federation_replays(protocol, provider_id, identifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
      ).run(protocol, providerId, identifier, now, now + ttlSeconds * 1000);
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) {
        throw new FederationTransactionError("federation_transaction_replayed", 409, "replay identifier was already used");
      }
      throw error;
    }
  }

  cleanup(now = Date.now(), maxRows = 256): number {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10000) throw new FederationTransactionError("federation_cleanup_invalid", 400, "cleanup limit is invalid");
    const result = this.database.prepare(
      "DELETE FROM federation_transactions WHERE transaction_id IN (SELECT transaction_id FROM federation_transactions WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?)"
    ).run(now, maxRows);
    const replayResult = this.database.prepare(
      "DELETE FROM federation_replays WHERE rowid IN (SELECT rowid FROM federation_replays WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?)"
    ).run(now, maxRows);
    return result.changes + replayResult.changes;
  }
}
