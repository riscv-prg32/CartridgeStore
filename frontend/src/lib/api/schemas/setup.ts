import { z } from "zod";

export const setupStateSchema = z.enum([
  "INFRASTRUCTURE_NOT_READY",
  "INSTALLATION_REQUIRED",
  "INSTALLATION_IN_PROGRESS",
  "INSTALLATION_COMPLETE",
  "INSTALLATION_RECOVERY_REQUIRED",
]);

export const setupStepSchema = z.enum([
  "admin",
  "store",
  "registration",
  "security",
  "smtp",
  "oidc",
  "saml",
  "mdns",
  "review",
]);

export const setupInfrastructureSchema = z
  .object({
    ready: z.boolean().optional(),
    fastify: z.boolean(),
    canonical_sqlite: z.boolean(),
    storage: z.boolean().optional(),
    writer_lease: z.boolean(),
    secret_registry: z.boolean().optional(),
    bootstrap_authorization: z.boolean().optional(),
    mdns_infrastructure_allowed: z.boolean().optional(),
  })
  .passthrough();

export const setupStatusResponseSchema = z
  .object({
    ok: z.literal(true),
    state: setupStateSchema,
    setup_required: z.boolean(),
    authorization_required: z.boolean(),
    infrastructure: setupInfrastructureSchema,
    public_origins: z
      .object({
        store: z.string().nullable(),
        api: z.string().nullable(),
      })
      .passthrough(),
    mdns: z
      .object({
        infrastructure_allowed: z.boolean(),
        application_enabled: z.boolean(),
        effective_enabled: z.boolean(),
        service_type: z.string(),
        abi: z.literal("prg32-store-discovery-1.0"),
        port: z.number().int().positive(),
        restart_required: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export const setupProgressResponseSchema = z
  .object({
    ok: z.literal(true),
    state: setupStateSchema,
    completed_steps: z.array(setupStepSchema),
    admin_user_id: z.number().int().positive().nullable(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    csrf_token: z.string().min(32),
    settings: z.record(z.string(), z.unknown()),
    providers: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export const setupAuthorizedResponseSchema = setupProgressResponseSchema.extend({
  authorized: z.literal(true),
});

export const setupCompleteResponseSchema = z
  .object({
    ok: z.literal(true),
    state: z.literal("INSTALLATION_COMPLETE"),
    redirect: z.string().startsWith("/"),
  })
  .passthrough();

export const setupResultResponseSchema = z
  .object({
    ok: z.literal(true),
    result: z.string().optional(),
    discovery: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();
