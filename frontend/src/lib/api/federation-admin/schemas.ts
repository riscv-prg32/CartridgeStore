import { z } from "zod";

const providerIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const nullableString = z.string().nullable();

/** Certificate metadata returned for a federation provider. */
export const federationCertificateSchema = z
  .object({
    fingerprint: z.string(),
    valid_from: z.string().optional(),
    valid_to: z.string().optional(),
  })
  .passthrough();

/** Full provider representation returned by administrative endpoints. */
export const federationProviderSchema = z
  .object({
    provider_id: providerIdSchema,
    protocol: z.enum(["oidc", "saml"]),
    display_name: z.string(),
    issuer: z.string(),
    enabled: z.boolean(),
    generation: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    client_id: nullableString,
    discovery_issuer: nullableString,
    redirect_uri: nullableString,
    scopes: z.array(z.string()),
    idp_entity_id: nullableString,
    sp_entity_id: nullableString,
    acs_url: nullableString,
    saml_entry_point: nullableString,
    saml_name_id_format: nullableString,
    saml_want_assertions_signed: z.boolean(),
    saml_want_authn_response_signed: z.boolean(),
    saml_sign_authn_requests: z.boolean(),
    saml_accepted_clock_skew_ms: z.number().int().nonnegative(),
    client_auth_method: z.enum([
      "client_secret_basic",
      "client_secret_post",
      "none",
    ]),
    client_secret_configured: z.boolean(),
    configuration_complete: z.boolean(),
    pending_transactions: z.number().int().nonnegative(),
    certificates: z.array(federationCertificateSchema),
    trusted_certificate_count: z.number().int().nonnegative(),
    trusted_certificate_capacity: z.number().int().positive(),
  })
  .passthrough();

export const federationProvidersResponseSchema = z
  .object({
    ok: z.literal(true),
    providers: z.array(federationProviderSchema),
  })
  .passthrough();

export const federationProviderResponseSchema = z
  .object({
    ok: z.literal(true),
    provider: federationProviderSchema,
  })
  .passthrough();

export const federationReauthResponseSchema = z
  .object({
    ok: z.literal(true),
    expires_in_seconds: z.number().int().positive(),
  })
  .passthrough();

export const federationSafeStatusSchema = z
  .object({
    providerId: providerIdSchema,
    protocol: z.enum(["oidc", "saml"]),
    displayName: z.string(),
    enabled: z.boolean(),
    generation: z.number().int(),
    pendingTransactions: z.number().int().nonnegative(),
    samlCertificateFingerprints: z.array(z.string()),
    updatedAt: z.string(),
  })
  .passthrough();

export const federationSafeStatusResponseSchema = z
  .object({
    ok: z.literal(true),
    provider: federationSafeStatusSchema,
  })
  .passthrough();

export const federationRevokeResponseSchema = z
  .object({
    ok: z.literal(true),
    revoked: z.number().int().nonnegative(),
    status: federationSafeStatusSchema.optional(),
  })
  .passthrough();

export const federationIdentitySchema = z
  .object({
    id: z.number().int().positive(),
    userId: z.number().int().positive(),
    protocol: z.enum(["oidc", "saml"]),
    providerId: providerIdSchema,
    issuer: z.string(),
    subject: z.string(),
    createdAt: z.string(),
    lastLoginAt: z.string().nullable(),
    unlinkedAt: z.string().nullable(),
  })
  .passthrough();

export const federationIdentitiesResponseSchema = z
  .object({
    ok: z.literal(true),
    identities: z.array(federationIdentitySchema),
  })
  .passthrough();

export const federationIdentityResponseSchema = z
  .object({
    ok: z.literal(true),
    identity: z.unknown(),
  })
  .passthrough();
