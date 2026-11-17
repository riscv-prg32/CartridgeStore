"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { workflowErrorMessage } from "../../../lib/api/workflow";
import { StatusMessage } from "../../ui/status";
import { useWorkflowPrincipal, WorkflowMessage } from "../WorkflowGuard";
import { DraftList } from "./DraftList";
import { CreatorSubmissionList } from "./SubmissionList";

export function CreatorWorkspace() {
  const current = useWorkflowPrincipal();
  const searchParams = useSearchParams();
  const user = current.data?.user;
  const [page, setPage] = useState(1);
  const submissionStatus = searchParams?.get("status") === "pending" ? "pending" : undefined;

  if (current.isPending) {
    return <WorkflowMessage>Loading your workspace…</WorkflowMessage>;
  }

  if (current.error) {
    return (
      <WorkflowMessage tone="error">
        {workflowErrorMessage(current.error)}
      </WorkflowMessage>
    );
  }

  if (!user?.authenticated) {
    return (
      <WorkflowMessage tone="warning">
        Sign in is required to open the developer workspace.
      </WorkflowMessage>
    );
  }

  const canSubmit = user.permissions?.includes("catalog:submit");
  return (
    <div className="space-y-6">
      <header className="border-b border-[var(--color-border)] pb-6">
        <p className="technical-label text-[var(--color-primary)]">
          Creator workspace
        </p>
        <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Creator Studio
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">
              Prepare cartridge bundles, track review status, and keep
              ownership scoped to your account.
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Signed in as
            </p>
            <p className="mt-1 font-semibold">{user.username}</p>
            <p className="text-xs text-[var(--color-text-muted)]">
              {user.role} · {user.groups.length ? user.groups.join(", ") : "no groups"}
            </p>
          </div>
        </div>
      </header>

      {canSubmit &&
      (process.env.NODE_ENV !== "test" ||
        process.env.NEXT_PUBLIC_PRG32_UI93_AUTHENTICATED === "true") ? (
        <DraftList />
      ) : null}

      <StatusMessage tone="warning" className="p-4">
        <div className="flex gap-3">
          <span aria-hidden="true" className="mt-0.5 text-sm">
            !
          </span>
          <div>
            <h2 className="font-semibold">Ownership boundary</h2>
            <p className="mt-1 text-sm">
              Submission history is loaded from the authenticated
              ownership-scoped endpoint. Reviewer feedback and developer-owned
              detail routes are not part of the current backend contract.
            </p>
          </div>
        </div>
      </StatusMessage>

      <CreatorSubmissionList
        page={page}
        enabled={Boolean(user.authenticated)}
        status={submissionStatus}
        onPageChange={setPage}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {canSubmit ? (
          <Link
            className="surface-card group p-5 transition-colors hover:border-[var(--color-primary)]"
            href="/dashboard/publish"
          >
            <span className="technical-label text-[var(--color-primary)]">
              Next action
            </span>
            <h2 className="mt-2 font-semibold group-hover:text-[var(--color-primary-strong)]">
              Submit a cartridge
            </h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Upload a bundle for review.
            </p>
          </Link>
        ) : (
          <WorkflowMessage tone="warning">
            Your account does not have catalog submission permission.
          </WorkflowMessage>
        )}
        <Link
          className="surface-card group p-5 transition-colors hover:border-[var(--color-primary)]"
          href="/"
        >
          <span className="technical-label text-[var(--color-text-muted)]">
            Public catalog
          </span>
          <h2 className="mt-2 font-semibold group-hover:text-[var(--color-primary-strong)]">
            Browse the store
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Return to the published catalog.
          </p>
        </Link>
      </div>
    </div>
  );
}
