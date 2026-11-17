import { z } from "zod";

import { paginationSchema } from "./workflow";

export const gameSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    authors: z.array(
      z.union([
        z.string(),
        z.object({ name: z.string().optional() }).passthrough(),
      ]),
    ),
    tags: z.array(z.string()),
    latest_version: z.string().nullable(),
    selected_version: z.string(),
    versions: z.array(z.string()),
    architectures: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    colophon: z.record(z.string(), z.unknown()).nullable(),
    variants: z.record(z.string(), z.record(z.string(), z.unknown())),
    publisher: z.string(),
    updated_at: z.string().nullable(),
  })
  .passthrough();

export const gamesResponseSchema = z
  .object({
    ok: z.literal(true),
    games: z.array(gameSchema),
    pagination: paginationSchema,
  })
  .passthrough();

export const gameResponseSchema = z
  .object({
    ok: z.literal(true),
    game: gameSchema,
  })
  .passthrough();

export const discoveryDocumentSchema = z
  .object({
    abi: z.literal("prg32-store-discovery-1.0"),
    name: z.string(),
    api: z.string(),
    web: z.string(),
    version: z.string(),
    auth_enabled: z.boolean(),
    roles: z.array(z.string()),
    services: z.record(z.string(), z.string()),
  })
  .passthrough();
