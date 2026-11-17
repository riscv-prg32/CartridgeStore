import crypto from "node:crypto";

import type Database from "better-sqlite3";

import type { AdminAuditLog } from "../admin/audit.js";
import type { FederationIdentityService, IdentityAuthorization } from "./identity.js";
import type { FederationProviderConfig, FederationProviderService, ProviderMutationContext } from "./provider.js";
import type { FederationTransactionStore } from "./transaction.js";
import type { FederationSecretPurpose, SecretStore } from "../secrets/service.js";
import { invalidateAccountAccess } from "../auth/account-state.js";

export type FederationOperationContext = ProviderMutationContext;

export interface SafeFederationProviderStatus {
  readonly providerId: string;
  readonly protocol: FederationProviderConfig["protocol"];
  readonly displayName: string;
  readonly enabled: boolean;
  readonly generation: number;
  readonly pendingTransactions: number;
  readonly samlCertificateFingerprints: readonly string[];
  readonly updatedAt: string;
}

function fingerprint(value: string): string {
  return crypto.createHash("sha256").update(value.replace(/\r\n/g, "\n").trim(), "utf8").digest("hex");
}

export class FederationProviderOperations {
  constructor(
    private readonly database: Database.Database,
    private readonly providers: FederationProviderService,
    private readonly transactions: FederationTransactionStore,
    private readonly identities: FederationIdentityService,
    private readonly secrets: SecretStore,
    private readonly audit?: AdminAuditLog
  ) {}

  status(providerId: string): SafeFederationProviderStatus {
    const provider = this.providers.get(providerId);
    return {
      providerId: provider.providerId,
      protocol: provider.protocol,
      displayName: provider.displayName,
      enabled: provider.enabled,
      generation: provider.generation,
      pendingTransactions: this.providers.pendingTransactionCount(provider.providerId),
      samlCertificateFingerprints: provider.samlTrustedCertificatesPem.map(fingerprint),
      updatedAt: provider.updatedAt
    };
  }

  preflightProviderSecret(providerId: string, purpose: FederationSecretPurpose, plaintext: string): void {
    this.secrets.encryptProviderSecret(providerId, purpose, plaintext);
  }

  identityIds(providerId: string): readonly number[] {
    this.providers.get(providerId);
    return (this.database.prepare("SELECT id FROM user_external_identities WHERE provider_id = ? AND unlinked_at IS NULL ORDER BY id").all(providerId) as Array<{ id: number }>).map((row) => row.id);
  }

  setEnabled(providerId: string, enabled: boolean, context: FederationOperationContext): SafeFederationProviderStatus {
    this.providers.setEnabled(providerId, enabled, context);
    return this.status(providerId);
  }

  updateTrustedSamlCertificates(providerId: string, certificates: readonly string[], context: FederationOperationContext): SafeFederationProviderStatus {
    this.providers.updateTrustedSamlCertificates(providerId, certificates, context);
    return this.status(providerId);
  }

  rotateProviderSecret(providerId: string, purpose: FederationSecretPurpose, plaintext: string, context: FederationOperationContext): SafeFederationProviderStatus {
    const provider = this.providers.get(providerId);
    if ((purpose === "oidc-client-secret" && provider.protocol !== "oidc") ||
        (purpose !== "oidc-client-secret" && provider.protocol !== "saml")) {
      throw new Error("secret purpose does not match provider protocol");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.secrets.setProviderSecret(this.database, provider.providerId, purpose, plaintext);
      this.database.prepare("UPDATE federation_providers SET generation = generation + 1, updated_at = datetime('now') WHERE provider_id = ?").run(provider.providerId);
      this.database.prepare("UPDATE federation_transactions SET consumed_at = ? WHERE provider_id = ? AND consumed_at IS NULL").run(Date.now(), provider.providerId);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    this.audit?.append({ actor_user_id: context.actorUserId, target_type: "federation_provider", target_id: provider.providerId, action: "federation.provider.secret_rotated", outcome: "committed", request_id: context.requestId });
    return this.status(provider.providerId);
  }

  revokePending(providerId: string, context: FederationOperationContext): { readonly revoked: number; readonly status: SafeFederationProviderStatus } {
    const revoked = this.transactions.revokePending(providerId);
    this.audit?.append({ actor_user_id: context.actorUserId, target_type: "federation_provider", target_id: providerId, action: "federation.provider.pending_revoked", outcome: "committed", request_id: context.requestId });
    return { revoked, status: this.status(providerId) };
  }

  retireIdentityLink(identityId: number, authorization: IdentityAuthorization): SafeFederationProviderStatus {
    const row = this.database.prepare("SELECT provider_id FROM user_external_identities WHERE id = ?").get(identityId) as { provider_id?: string } | undefined;
    if (!row?.provider_id) throw new Error("federated identity is unknown");
    this.identities.unlink(identityId, authorization);
    return this.status(row.provider_id);
  }

  setLocalAccountDisabled(userId: number, disabled: boolean, context: FederationOperationContext): void {
    const next = disabled ? new Date().toISOString() : null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.database.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(next, userId).changes;
      if (changed !== 1) throw new Error("local account is unknown");
      if (disabled) invalidateAccountAccess(this.database, userId);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    this.audit?.append({ actor_user_id: context.actorUserId, target_type: "user", target_id: String(userId), action: disabled ? "user.disabled" : "user.enabled", outcome: "committed", request_id: context.requestId });
  }
}
