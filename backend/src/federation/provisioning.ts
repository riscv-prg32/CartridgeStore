import type Database from "better-sqlite3";

import { CanonicalWriterLease } from "../storage-v2/writer-lock.js";
import {
  FederationProviderError
} from "./provider.js";
import type { FederationProviderConfig, FederationProviderService, ProviderInput } from "./provider.js";
import { FederationIdentityError } from "./identity.js";
import type { FederationIdentityService, LegacyIdentityIssue } from "./identity.js";

export const FEDERATION_PROVISIONING_AUTHORIZATION = "prg32-disposable-federation-provisioning-v1";

export type LegacyFederationFieldClass =
  | "PUBLIC_METADATA"
  | "NON_SECRET_CONFIGURATION"
  | "SECRET_REFERENCE"
  | "SECRET_VALUE"
  | "DERIVED_VALUE"
  | "LEGACY_ONLY"
  | "UNKNOWN";

export interface LegacyFederationFieldInventory {
  readonly field: string;
  readonly source: "environment" | "store_settings";
  readonly present: boolean;
  readonly classification: LegacyFederationFieldClass;
  readonly canonicalDestination: string | null;
  readonly operatorInputRequired: boolean;
}

export interface FederationProvisioningProvider extends ProviderInput {
  readonly legacyProviderIds: readonly string[];
  readonly enabled?: boolean;
}

export interface FederationProvisioningDocument {
  readonly version: 1;
  readonly providers: readonly FederationProvisioningProvider[];
}

export interface FederationProvisioningOptions {
  readonly database: Database.Database;
  readonly providers: FederationProviderService;
  readonly identities: FederationIdentityService;
  readonly document: FederationProvisioningDocument;
  readonly authorization: string;
  readonly mode: "validate" | "apply";
  readonly writerRoot?: string;
  readonly allowHttp?: boolean;
  readonly apiOrigin?: string;
  readonly storeOrigin?: string;
}

export interface FederationProvisioningResult {
  readonly mode: "validate" | "apply";
  readonly providerIds: readonly string[];
  readonly alreadyPresent: readonly string[];
  readonly identityMigration: { readonly migrated: number; readonly alreadyMapped: number; readonly skipped: number };
  readonly unresolvedIdentities: readonly LegacyIdentityIssue[];
}

const LEGACY_FIELDS: ReadonlyArray<{
  readonly field: string;
  readonly sourceKey: string;
  readonly classification: LegacyFederationFieldClass;
  readonly destination: string | null;
  readonly operatorInputRequired: boolean;
}> = [
  { field: "oidc_enabled", sourceKey: "oidc_enabled", classification: "LEGACY_ONLY", destination: "provider.enabled", operatorInputRequired: true },
  { field: "oidc_issuer", sourceKey: "oidc_issuer", classification: "PUBLIC_METADATA", destination: "federation_providers.issuer", operatorInputRequired: true },
  { field: "oidc_client_id", sourceKey: "oidc_client_id", classification: "NON_SECRET_CONFIGURATION", destination: "federation_providers.client_id", operatorInputRequired: true },
  { field: "oidc_client_secret", sourceKey: "oidc_client_secret", classification: "SECRET_VALUE", destination: "federation_provider_secrets(oidc-client-secret)", operatorInputRequired: true },
  { field: "oidc_scope", sourceKey: "oidc_scope", classification: "NON_SECRET_CONFIGURATION", destination: "federation_providers.scopes_json", operatorInputRequired: false },
  { field: "saml_enabled", sourceKey: "saml_enabled", classification: "LEGACY_ONLY", destination: "provider.enabled", operatorInputRequired: true },
  { field: "saml_entity_id", sourceKey: "saml_entity_id", classification: "PUBLIC_METADATA", destination: "federation_providers.sp_entity_id", operatorInputRequired: true },
  { field: "saml_acs_url", sourceKey: "saml_acs_url", classification: "PUBLIC_METADATA", destination: "federation_providers.acs_url", operatorInputRequired: true },
  { field: "saml_sls_url", sourceKey: "saml_sls_url", classification: "PUBLIC_METADATA", destination: null, operatorInputRequired: true },
  { field: "saml_idp_entity_id", sourceKey: "saml_idp_entity_id", classification: "PUBLIC_METADATA", destination: "federation_providers.idp_entity_id", operatorInputRequired: true },
  { field: "saml_idp_sso_url", sourceKey: "saml_idp_sso_url", classification: "PUBLIC_METADATA", destination: "federation_providers.saml_entry_point", operatorInputRequired: true },
  { field: "saml_idp_slo_url", sourceKey: "saml_idp_slo_url", classification: "LEGACY_ONLY", destination: null, operatorInputRequired: false },
  { field: "saml_idp_x509cert", sourceKey: "saml_idp_x509cert", classification: "PUBLIC_METADATA", destination: "federation_providers.saml_idp_certificate_pem", operatorInputRequired: true }
];

function fieldValue(settings: Readonly<Record<string, unknown>>, key: string): unknown {
  const value = settings[key];
  return typeof value === "string" ? value.trim() : value;
}

export function inventoryLegacyFederationSettings(
  environment: Readonly<Record<string, unknown>> = {},
  settings: Readonly<Record<string, unknown>> = {}
): readonly LegacyFederationFieldInventory[] {
  return LEGACY_FIELDS.map((definition) => {
    const environmentKey = `PRG32_${definition.sourceKey.toUpperCase()}`;
    const environmentValue = fieldValue(environment, environmentKey);
    const settingValue = fieldValue(settings, definition.sourceKey);
    return {
      field: definition.field,
      source: environmentValue !== undefined && environmentValue !== "" ? "environment" : "store_settings",
      present: environmentValue !== undefined && environmentValue !== "" || settingValue !== undefined && settingValue !== "",
      classification: definition.classification,
      canonicalDestination: definition.destination,
      operatorInputRequired: definition.operatorInputRequired
    };
  });
}

function rejectInlineSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectInlineSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(client_?secret|private_?key|password|access_?token|refresh_?token)/iu.test(key) && !/reference$/iu.test(key)) {
      throw new FederationProviderError("federation_inline_secret_rejected", 400, `${path}.${key} must be a secret reference, not a secret value`);
    }
    rejectInlineSecrets(child, `${path}.${key}`);
  }
}

function assertOrigins(options: FederationProvisioningOptions, provider: FederationProvisioningProvider): void {
  if (!options.apiOrigin && !options.storeOrigin) return;
  if (!options.apiOrigin || !options.storeOrigin) throw new FederationProviderError("federation_origin_configuration_incomplete", 400, "API and storefront origins must be provided together");
  const api = new URL(options.apiOrigin);
  const store = new URL(options.storeOrigin);
  if (api.origin === store.origin) throw new FederationProviderError("federation_origin_not_separated", 400, "API and storefront origins must be distinct");
  const callback = provider.protocol === "oidc" ? provider.redirectUri : provider.acsUrl;
  if (!callback || new URL(callback).origin !== api.origin) throw new FederationProviderError("federation_callback_origin_invalid", 400, "federation callback must use the API origin");
}

function validateDocument(options: FederationProvisioningOptions): {
  readonly inputs: readonly ProviderInput[];
  readonly candidates: readonly FederationProviderConfig[];
  readonly providerMap: ReadonlyMap<string, string>;
} {
  if (options.authorization !== FEDERATION_PROVISIONING_AUTHORIZATION) throw new FederationProviderError("federation_provisioning_authorization_required", 403, "explicit disposable federation provisioning authorization is required");
  if (options.document.version !== 1 || !Array.isArray(options.document.providers) || options.document.providers.length > 32) throw new FederationProviderError("federation_provisioning_document_invalid", 400, "federation provisioning document is invalid");
  rejectInlineSecrets(options.document, "document");
  const providerIds = new Set<string>();
  const legacyMap = new Map<string, string>();
  const inputs: ProviderInput[] = [];
  const candidates: FederationProviderConfig[] = [];
  for (const entry of options.document.providers as readonly FederationProvisioningProvider[]) {
    if (entry.enabled === true) throw new FederationProviderError("federation_provider_activation_required", 400, "provisioning cannot enable a provider implicitly");
    const normalized = options.providers.normalizeForProvisioning(entry, options.allowHttp ?? false);
    assertOrigins(options, entry);
    if (normalized.protocol === "oidc" && (!normalized.clientId || !normalized.redirectUri)) throw new FederationProviderError("federation_provider_incomplete", 400, "OIDC client id and redirect URI are required");
    if (normalized.protocol === "oidc" && normalized.clientAuthMethod !== "none" && !normalized.clientSecretReference) throw new FederationProviderError("federation_provider_secret_reference_required", 400, "OIDC client secret reference is required");
    if (providerIds.has(normalized.providerId)) throw new FederationProviderError("federation_provider_duplicate", 409, "provider document contains duplicate provider ids");
    providerIds.add(normalized.providerId);
    candidates.push(normalized);
    for (const legacyId of entry.legacyProviderIds) {
      if (typeof legacyId !== "string" || legacyId.trim() === "") throw new FederationProviderError("federation_mapping_invalid", 400, "legacy provider identifiers must be non-empty strings");
      const existing = legacyMap.get(legacyId);
      if (existing && existing !== normalized.providerId) throw new FederationProviderError("federation_mapping_ambiguous", 409, "legacy provider maps to multiple canonical providers");
      legacyMap.set(legacyId, normalized.providerId);
    }
    const input = { ...entry } as ProviderInput & { legacyProviderIds?: readonly string[]; enabled?: boolean };
    delete input.legacyProviderIds;
    delete input.enabled;
    inputs.push(input);
  }
  return { inputs, candidates, providerMap: legacyMap };
}

export function provisionFederation(options: FederationProvisioningOptions): FederationProvisioningResult {
  const { inputs, candidates, providerMap } = validateDocument(options);
  const unresolved = options.identities.inspectLegacyMappings({ providerMap, providerCandidates: candidates });
  if (unresolved.length > 0) throw new FederationIdentityError("federation_legacy_identity_unresolved", 409, "legacy federated identity mappings are unresolved");
  const providerIds = inputs.map((input) => input.providerId);
  if (options.mode === "validate") {
    return { mode: "validate", providerIds, alreadyPresent: [], identityMigration: { migrated: 0, alreadyMapped: 0, skipped: 0 }, unresolvedIdentities: [] };
  }
  if (!options.writerRoot) throw new FederationProviderError("federation_writer_root_required", 400, "disposable writer root is required for apply mode");
  const lease = new CanonicalWriterLease(options.writerRoot);
  try {
    const provisioned = options.providers.provisionMany(inputs, options.allowHttp ?? false);
    const identityMigration = options.identities.migrateLegacyMappings({ strict: true, providerMap });
    return { mode: "apply", providerIds, alreadyPresent: provisioned.alreadyPresent, identityMigration, unresolvedIdentities: [] };
  } finally {
    lease.close();
  }
}
