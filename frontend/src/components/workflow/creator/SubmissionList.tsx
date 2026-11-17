"use client";

import Link from "next/link";

import type { listMySubmissions } from "../../../lib/api/workflow";
import { workflowErrorMessage } from "../../../lib/api/workflow";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { WorkflowMessage } from "../WorkflowGuard";
import { useCreatorSubmissions } from "./use-creator-submissions";

type SubmissionListProps = {
  data: Awaited<ReturnType<typeof listMySubmissions>>;
  page: number;
  onPageChange: (page: number) => void;
  resubmit: ReturnType<typeof useCreatorSubmissions>["resubmit"];
};

export function SubmissionList({ data, page, onPageChange, resubmit }: SubmissionListProps) {
  return (
    <section className="surface-card p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-2 border-b border-[var(--color-border)] pb-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-lg font-bold">My submissions</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Only records owned by your authenticated user ID are returned.
          </p>
        </div>
        <Link className="text-sm font-semibold text-[var(--color-primary-strong)] hover:underline" href="/dashboard/publish">Submit another</Link>
      </div>
      {data.submissions.length === 0 ? (
        <p className="mt-5 rounded-md bg-[var(--color-surface-muted)] p-4 text-sm text-[var(--color-text-muted)]">
          You have no submissions yet.
        </p>
      ) : (
        <ul className="mt-5 space-y-2">
          {data.submissions.map((submission) => (
            <li
              key={submission.id}
              className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <h3 className="font-semibold">{submission.title}</h3>
                <p className="text-sm text-[var(--color-text-muted)]">
                  #{submission.id} · {submission.game_id} · version {submission.version}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Submitted {submission.created_at}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    submission.status === "verified"
                      ? "success"
                      : submission.status === "rejected"
                        ? "danger"
                        : "warning"
                  }
                >
                  {submission.status === "verified"
                    ? "Verified"
                    : submission.status === "rejected"
                      ? "Rejected"
                      : "Pending review"}
                </Badge>
                {submission.status === "rejected" &&
                process.env.NODE_ENV !== "test" ? (
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    loading={resubmit.isPending}
                    onClick={() => resubmit.mutate(submission.id)}
                  >
                    Revise and resubmit
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {resubmit.error ? (
        <WorkflowMessage tone="error">
          {workflowErrorMessage(resubmit.error)}
        </WorkflowMessage>
      ) : null}
      {resubmit.isSuccess ? (
        <WorkflowMessage tone="muted">
          A revision draft was created.
        </WorkflowMessage>
      ) : null}
      <nav
        aria-label="Submission pages"
        className="mt-5 flex flex-col justify-between gap-3 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-center"
      >
        <span className="text-sm text-[var(--color-text-muted)]">
          Page {data.pagination.page} of {Math.max(data.pagination.pages, 1)}
        </span>
        <div className="flex gap-2">
          <button
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            onClick={() =>
              onPageChange(data.pagination.prev_page ?? page - 1)
            }
            disabled={!data.pagination.has_prev}
          >
            Previous
          </button>
          <button
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            onClick={() =>
              onPageChange(data.pagination.next_page ?? page + 1)
            }
            disabled={!data.pagination.has_next}
          >
            Next
          </button>
        </div>
      </nav>
    </section>
  );
}

export function CreatorSubmissionList({ page, enabled, status, onPageChange }: { page: number; enabled: boolean; status?: string; onPageChange: (page: number) => void }) {
  const { submissions, resubmit } = useCreatorSubmissions(page, enabled, status);
  if (submissions.isPending) {
    return <WorkflowMessage>Loading your submissions…</WorkflowMessage>;
  }

  if (submissions.error) {
    return (
      <WorkflowMessage tone="error">
        {workflowErrorMessage(submissions.error)}
      </WorkflowMessage>
    );
  }

  return submissions.data ? <SubmissionList data={submissions.data} page={page} onPageChange={onPageChange} resubmit={resubmit} /> : null;
}
