import { z } from "zod";

/** Shared authenticated principal returned by Fastify. */
export const principalSchema = z
  .object({
    id: z.number().int().nullable(),
    name: z.string(),
    username: z.string(),
    email: z.string(),
    role: z.string(),
    groups: z.array(z.string()),
    authenticated: z.boolean(),
    permissions: z.array(z.string()).optional().default([]),
  })
  .passthrough();

export const apiErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
    user: principalSchema.optional(),
  })
  .passthrough();

/** Common success envelope used by typed administrative API calls. */
export const adminResponseSchema = z
  .object({ ok: z.literal(true) })
  .passthrough();

export const csrfResponseSchema = z
  .object({
    ok: z.literal(true),
    csrf_token: z.string().min(32),
  })
  .passthrough();

export const authProvidersResponseSchema = z
  .object({
    ok: z.literal(true),
    providers: z.array(
      z
        .object({
          provider_id: z.string().min(1),
          protocol: z.enum(["oidc", "saml"]),
          display_name: z.string().min(1),
          enabled: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const authUserResponseSchema = z
  .object({
    ok: z.literal(true),
    user: principalSchema,
  })
  .passthrough();

export const authProfileResponseSchema = z
  .object({
    ok: z.literal(true),
    user: principalSchema,
  })
  .passthrough();

export const authLogoutResponseSchema = z
  .object({ ok: z.literal(true) })
  .passthrough();

export const authOperationResponseSchema = z
  .object({ ok: z.literal(true), message: z.string() })
  .passthrough();

export const authTokenSchema = z
  .object({
    id: z.number().int().positive(),
    label: z.string(),
    created_at: z.string(),
    last_used: z.string(),
  })
  .passthrough();

export const authTokensResponseSchema = z
  .object({
    ok: z.literal(true),
    tokens: z.array(authTokenSchema),
  })
  .passthrough();

export const authTokenCreatedResponseSchema = z
  .object({
    ok: z.literal(true),
    id: z.number().int().positive(),
    label: z.string(),
    token: z.string().min(1),
  })
  .passthrough();

export const authTokenUpdatedResponseSchema = z
  .object({
    ok: z.literal(true),
    id: z.number().int().positive(),
    label: z.string(),
  })
  .passthrough();

export const registrationRequestedResponseSchema = z
  .object({
    ok: z.literal(true),
    email: z.string(),
    message: z.string(),
  })
  .passthrough();

export const passkeySchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    device_type: z.string(),
    backed_up: z.boolean(),
    transports: z.array(z.string()),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    revoked: z.boolean(),
  })
  .passthrough();

export const passkeysResponseSchema = z
  .object({
    ok: z.literal(true),
    credentials: z.array(passkeySchema),
  })
  .passthrough();

export const passkeyOptionsResponseSchema = z
  .object({
    ok: z.literal(true),
    options: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const passkeyMutationResponseSchema = z
  .object({ ok: z.literal(true) })
  .passthrough();
