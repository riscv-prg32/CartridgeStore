import { z } from "zod";

export const workflowSubmissionSchema = z
  .object({
    id: z.number().int().positive(),
    game_id: z.string(),
    version: z.string(),
    status: z.string(),
    submitted_by_user_id: z.number().int().nullable(),
    submitted_by: z.string(),
    reviewed_by_user_id: z.number().int().nullable(),
    reviewed_by: z.string().nullable(),
    pending_dir: z.string().nullable(),
    metadata_json: z.string(),
    architectures_json: z.string(),
    created_at: z.string(),
    reviewed_at: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    architectures: z.array(z.record(z.string(), z.unknown())),
    revision_of_submission_id: z.number().int().nullable().optional(),
    revision_number: z.number().int().optional(),
    review_history: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
  })
  .passthrough();

export const publisherDraftSchema = z
  .object({
    id: z.string(),
    status: z.enum(["draft", "submitting", "submitted", "abandoned"]),
    metadata: z.record(z.string(), z.unknown()),
    has_artifact: z.boolean(),
    source_submission_id: z.number().int().nullable(),
    submitted_submission_id: z.number().int().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    submitted_at: z.string().nullable(),
  })
  .passthrough();

export const draftResponseSchema = z
  .object({ ok: z.literal(true), draft: publisherDraftSchema })
  .passthrough();

export const draftListResponseSchema = z
  .object({
    ok: z.literal(true),
    drafts: z.array(publisherDraftSchema),
  })
  .passthrough();

export const workflowSubmissionListResponseSchema = z
  .object({
    ok: z.literal(true),
    submissions: z.array(workflowSubmissionSchema),
  })
  .passthrough();

export const workflowSubmissionResponseSchema = z
  .object({
    ok: z.literal(true),
    submission: workflowSubmissionSchema,
  })
  .passthrough();

export const workflowSubmissionResultSchema = z
  .object({
    status: z.literal("pending"),
    ok: z.literal(true),
    review_required: z.literal(true),
    submission_id: z.number().int().positive(),
    // Legacy responses used a numeric id; storage-v2 uses a stable cartridge id.
    id: z.union([z.string().min(1), z.number().int().positive()]),
    version: z.string(),
    submitted: z.array(
      z
        .object({
          architecture: z.string(),
          file: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const ownedSubmissionSummarySchema = z
  .object({
    id: z.number().int().positive(),
    game_id: z.string(),
    title: z.string(),
    version: z.string(),
    status: z.string(),
    created_at: z.string(),
    reviewed_at: z.string().nullable(),
  })
  .passthrough();

export const paginationSchema = z
  .object({
    page: z.number().int(),
    per_page: z.number().int(),
    total: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
    has_next: z.boolean(),
    has_prev: z.boolean(),
    next_page: z.number().int().nullable(),
    prev_page: z.number().int().nullable(),
  })
  .passthrough();

export const ownedSubmissionListResponseSchema = z
  .object({
    ok: z.literal(true),
    submissions: z.array(ownedSubmissionSummarySchema),
    pagination: paginationSchema,
  })
  .passthrough();
