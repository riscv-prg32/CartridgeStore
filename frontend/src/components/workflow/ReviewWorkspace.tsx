"use client";

import { ClipboardCheck, ListChecks } from "lucide-react";

import { useReview } from "./review/use-review";
import { ReviewQueue } from "./review/ReviewQueue";
import { ReviewSubmission } from "./review/ReviewSubmission";
import { WorkflowGuard } from "./WorkflowGuard";

export function ReviewWorkspace() {
  return <WorkflowGuard permission="submissions:read"><ReviewWorkspaceContent /></WorkflowGuard>;
}

function ReviewWorkspaceContent() {
  const state = useReview();
  const loadedCount = state.list.data?.submissions.length;

  return <div className="space-y-8"><header className="border-b border-[var(--color-border)] pb-7"><div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="technical-label text-[var(--color-primary)]">Moderation workspace / 01</p><h1 className="mt-2 text-4xl font-bold tracking-tight">Review submissions</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">Keep the publication queue moving. Inspect a bundle, refine its public metadata, and record a clear decision.</p></div><div className="grid grid-cols-2 gap-2 sm:min-w-52"><div className="border-l-2 border-[var(--color-primary)] pl-3"><p className="technical-label text-[var(--color-text-muted)]">View</p><p className="mt-1 text-sm font-semibold">{state.status}</p></div><div className="border-l-2 border-[var(--color-border)] pl-3"><p className="technical-label text-[var(--color-text-muted)]">Loaded</p><p className="mt-1 text-sm font-semibold">{loadedCount ?? "—"}</p></div></div></div></header><div className="grid gap-8 xl:grid-cols-[minmax(18rem,.78fr)_minmax(0,1.35fr)]"><ReviewQueue state={state} /><ReviewSubmission state={state} /></div><div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><ListChecks aria-hidden="true" className="size-4 text-[var(--color-primary)]" /><span>Review changes are applied only when an approval is recorded.</span><ClipboardCheck aria-hidden="true" className="ml-auto size-4" /></div></div>;
}
