import type Database from "better-sqlite3";

import type { AdminAuditLog } from "../admin/audit.js";
import { AdminAuditLog as AdminAuditLogImpl } from "../admin/audit.js";
import type { AuthService } from "../auth/service.js";
import type { BackendConfig } from "../config/env.js";
import { FederationIdentityService } from "./identity.js";
import { FederationProviderOperations } from "./operations.js";
import { FederationProviderService } from "./provider.js";
import { FederationTransactionStore } from "./transaction.js";
import { OidcService } from "../oidc/service.js";
import { SamlService } from "../saml/service.js";
import type { SecretStore } from "../secrets/service.js";
import { FederationLinkChallengeService } from "./link-challenges.js";

export interface FederationRuntime {
  readonly providers: FederationProviderService;
  readonly identities: FederationIdentityService;
  readonly audit: AdminAuditLog;
  readonly oidc: OidcService;
  readonly saml: SamlService;
  readonly operations: FederationProviderOperations;
  readonly linkChallenges: FederationLinkChallengeService;
}

export interface FederationRuntimeOptions {
  readonly config: BackendConfig;
  readonly auth: AuthService;
  readonly secrets: SecretStore;
  readonly audit?: AdminAuditLog;
}

/**
 * Compose the federation services only when the existing write/session gate
 * allows them. This is deliberately a composition boundary: service logic,
 * persistence, and protocol behavior remain in their existing modules.
 */
export function createFederationRuntime(options: FederationRuntimeOptions): FederationRuntime | null {
  if (!options.auth.isWriteEnabled() || !options.config.authSessionSecret) return null;

  const writer: Database.Database = options.auth.writableDatabase();
  const audit = options.audit ?? new AdminAuditLogImpl(options.config, writer);
  const providers = new FederationProviderService(writer, audit);
  const identities = new FederationIdentityService(writer, providers, audit, {
    autoProvision: options.config.federationAutoProvision
  });
  identities.migrateLegacyMappings();
  const transactions = new FederationTransactionStore(writer, options.config.authSessionSecret, providers);
  const linkChallenges = new FederationLinkChallengeService();

  return {
    providers,
    identities,
    audit,
    oidc: new OidcService(options.config, writer, options.auth, providers, identities, transactions, options.secrets, audit, linkChallenges),
    saml: new SamlService(options.config, writer, options.auth, providers, identities, transactions, options.secrets, audit, linkChallenges),
    operations: new FederationProviderOperations(writer, providers, transactions, identities, options.secrets, audit),
    linkChallenges
  };
}
