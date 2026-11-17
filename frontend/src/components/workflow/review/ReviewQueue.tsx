"use client";

import { CheckCircle2, ChevronRight, Clock3, Inbox, XCircle } from "lucide-react";

import { Button } from "../../ui/button";
import { WorkflowMessage } from "../WorkflowGuard";
import { workflowErrorMessage } from "../../../lib/api/workflow";
import type { ReviewState } from "./use-review";
import { Badge } from "../../ui/badge";

const statusOptions = [
  { value: "pending", label: "Pending", icon: Clock3 },
  { value: "verified", label: "Approved", icon: CheckCircle2 },
  { value: "rejected", label: "Rejected", icon: XCircle },
  { value: "all", label: "All", icon: Inbox },
] as const;

function statusVariant(status: string) {
  if (status === "verified") return "success" as const;
  if (status === "rejected") return "danger" as const;
  return "warning" as const;
}

export function ReviewQueue({ state }: { state: ReviewState }) {
  const { status, selectedId, list } = state;
  return <>
    <section className="surface-card overflow-hidden" aria-labelledby="review-queue-heading"><div className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div><p className="technical-label text-[var(--color-primary)]">Release pipeline / 02</p><h2 id="review-queue-heading" className="mt-1 text-lg font-bold">Submission queue</h2><p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Choose a release to inspect the bundle and its publication data.</p></div><span className="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><Inbox aria-hidden="true" className="size-4" /></span></div><div className="mt-4 grid grid-cols-2 gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 sm:grid-cols-4" role="tablist" aria-label="Submission status">{statusOptions.map(({ value, label, icon: Icon }) => <Button key={value} type="button" size="sm" variant={status === value ? "primary" : "ghost"} className="min-w-0 px-2 text-xs" role="tab" aria-selected={status === value} onClick={() => state.selectStatus(value)}><Icon aria-hidden="true" className="size-3.5" /><span className="truncate">{label}</span></Button>)}</div></div>
    {list.isPending && <WorkflowMessage>Loading submissions…</WorkflowMessage>}
    {list.error && <WorkflowMessage tone="error">{workflowErrorMessage(list.error)}</WorkflowMessage>}
    {list.data && <div className="p-4 sm:p-5">{list.data.submissions.length === 0 ? <div className="grid min-h-56 place-items-center rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 p-6 text-center"><div><Inbox aria-hidden="true" className="mx-auto size-7 text-[var(--color-primary)]" /><p className="mt-3 text-sm font-semibold">No submissions here</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">Try another queue filter or wait for a new release.</p></div></div> : <ul className="space-y-2">{list.data.submissions.map((submission) => <li key={submission.id}><button className={`group w-full rounded-md border p-3.5 text-left transition-[border-color,background-color,transform] hover:-translate-y-0.5 hover:border-[var(--color-primary)] ${selectedId === submission.id ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] shadow-sm" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`} type="button" onClick={() => state.selectSubmission(submission)}><span className="flex items-start justify-between gap-3"><span className="min-w-0"><span className="block truncate text-sm font-semibold">#{submission.id} {String(submission.metadata.title ?? submission.game_id)}</span><span className="mt-1 block text-xs text-[var(--color-text-muted)]">{submission.submitted_by}</span></span><span className="flex shrink-0 items-center gap-2"><Badge variant={statusVariant(submission.status)}>{submission.status}</Badge><ChevronRight aria-hidden="true" className={`size-4 transition-transform group-hover:translate-x-0.5 ${selectedId === submission.id ? "text-[var(--color-primary-strong)]" : "text-[var(--color-text-muted)]"}`} /></span></span><span className="mt-3 block border-t border-[var(--color-border)] pt-2 text-[11px] text-[var(--color-text-muted)]">Version {submission.version}</span></button></li>)}</ul>}</div>}
    </section>
  </>;
}
