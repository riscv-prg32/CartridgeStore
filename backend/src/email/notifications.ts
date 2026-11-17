import type Database from "better-sqlite3";

import type { SubmissionRecord } from "../review/service.js";
import type { EmailService } from "./service.js";

export type ApprovalNotifier = (submission: SubmissionRecord, database: Database.Database) => Promise<void>;

export function createApprovalNotifier(options: {
  readonly email: EmailService;
  readonly publicOrigin?: string;
  readonly storeName: string;
}): ApprovalNotifier {
  return async (submission, database) => {
    if (submission.submitted_by_user_id === null) return;
    const recipient = database.prepare("SELECT email FROM users WHERE id = ?").get(submission.submitted_by_user_id) as { email?: unknown } | undefined;
    if (typeof recipient?.email !== "string" || !recipient.email.trim()) return;
    const title = typeof submission.metadata.title === "string" && submission.metadata.title.trim() ? submission.metadata.title : submission.game_id;
    await options.email.sendCartridgeApproved(recipient.email, {
      recipientName: submission.submitted_by,
      gameTitle: title,
      gameId: submission.game_id,
      version: submission.version,
      reviewerName: submission.reviewed_by,
      storeName: options.storeName,
      ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
    });
  };
}
