import type { z } from "zod";

import {
  setupProgressResponseSchema,
  setupStatusResponseSchema,
} from "../schemas";

/** Current installation state exposed by the setup API. */
export type SetupState = z.infer<typeof setupStatusResponseSchema>["state"];

/** A setup step accepted by the progress endpoint. */
export type SetupStep = z.infer<
  typeof setupProgressResponseSchema
>["completed_steps"][number];

/** Validated setup status response. */
export type SetupStatus = z.infer<typeof setupStatusResponseSchema>;

/** Validated setup progress response. */
export type SetupProgress = z.infer<typeof setupProgressResponseSchema>;
