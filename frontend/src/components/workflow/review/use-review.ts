"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { approveSubmission, getSubmission, listSubmissions, rejectSubmission } from "../../../lib/api/workflow";
import { reviewQueryKeys, workflowQueryKeys } from "../../../lib/api/query-keys";
import type { WorkflowSubmission } from "../../../lib/api/contracts";
import { useWorkflowPrincipal } from "../WorkflowGuard";

const EDITABLE_METADATA_FIELDS = ["title", "summary", "description", "license", "homepage", "repository", "tags"] as const;

function metadataForSubmission(submission: WorkflowSubmission): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const key of EDITABLE_METADATA_FIELDS) {
    const value = submission.metadata[key];
    metadata[key] = Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : "";
  }
  return metadata;
}

export function useReview() {
  const current = useWorkflowPrincipal();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("pending");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const list = useQuery({ queryKey: reviewQueryKeys.queue(status), queryFn: () => listSubmissions(status === "all" ? undefined : status), retry: false });
  const detail = useQuery({ queryKey: reviewQueryKeys.submission(selectedId), queryFn: () => getSubmission(selectedId as number), enabled: selectedId !== null, retry: false });
  const invalidateDecisionQueries = () => {
    void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.submissionsRoot() });
    void queryClient.invalidateQueries({ queryKey: reviewQueryKeys.submission(selectedId) });
  };
  const approve = useMutation({
    mutationFn: ({ id, nextMetadata, nextNote }: { id: number; nextMetadata: Record<string, unknown>; nextNote: string }) => approveSubmission(id, nextMetadata, nextNote),
    retry: false,
    onSuccess: invalidateDecisionQueries,
  });
  const reject = useMutation({
    mutationFn: ({ id, nextNote }: { id: number; nextNote: string }) => rejectSubmission(id, nextNote),
    retry: false,
    onSuccess: invalidateDecisionQueries,
  });
  const selected = detail.data?.submission;
  const canApprove = current.data?.user.permissions?.includes("submissions:review") && selected?.status === "pending";
  const canReject = current.data?.user.permissions?.includes("submissions:reject") && selected?.status === "pending";

  function selectStatus(nextStatus: string) {
    setStatus(nextStatus);
    setSelectedId(null);
    setMetadata({});
    setNote("");
  }

  function selectSubmission(submission: WorkflowSubmission) {
    setSelectedId(submission.id);
    setMetadata(metadataForSubmission(submission));
    setNote("");
  }

  function metadataForApproval(): Record<string, unknown> {
    return { ...metadata, tags: (metadata.tags ?? "").split(",").map((item) => item.trim()).filter(Boolean) };
  }

  return { current, status, selectedId, selected, metadata, note, list, detail, approve, reject, canApprove, canReject, setMetadata, setNote, selectStatus, selectSubmission, metadataForApproval };
}

export type ReviewState = ReturnType<typeof useReview>;
export { EDITABLE_METADATA_FIELDS };
