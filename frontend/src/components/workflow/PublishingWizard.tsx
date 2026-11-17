"use client";

import { Button } from "../ui/button";
import { StatusMessage } from "../ui/status";
import { useWorkflowPrincipal, WorkflowGuard } from "./WorkflowGuard";
import { PublishingSteps } from "./publishing/PublishingSteps";
import { usePublishing } from "./publishing/use-publishing";

export function PublishingWizard() {
  return <WorkflowGuard permission="catalog:submit"><PublishingWizardForm /></WorkflowGuard>;
}

function PublishingWizardForm() {
  const current = useWorkflowPrincipal();
  const state = usePublishing();

  if (state.submission.data) {
    return <StatusMessage tone="success" className="p-6"><p className="technical-label text-emerald-700">Workflow complete</p><h1 className="mt-2 text-2xl font-bold">Submission received</h1><p>Submission #{state.submission.data.submission_id} is pending review. It is not published automatically.</p><p className="text-sm">Version: {state.submission.data.version} · Architectures: {state.submission.data.submitted.map((item) => item.architecture).join(", ") || "not reported"}</p><Button type="button" variant="secondary" onClick={state.reset}>Submit another bundle</Button></StatusMessage>;
  }

  return <div className="space-y-6"><header className="border-b border-[var(--color-border)] pb-6"><p className="technical-label text-[var(--color-primary)]">Creator Studio / Publishing</p><h1 className="mt-1 text-3xl font-bold">Submit a cartridge</h1><p className="mt-2 text-[var(--color-text-muted)]">The isolated Fastify workflow validates the bundle and creates a pending review submission.</p></header><PublishingSteps state={state} />{current.data?.user && <p className="text-xs text-[var(--color-text-muted)]">Submitting as {current.data.user.username}.</p>}</div>;
}
