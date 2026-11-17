"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { attachDraftArtifact, createDraft, deleteDraft, listDrafts, submitDraft } from "../../../lib/api/workflow";
import { workflowQueryKeys } from "../../../lib/api/query-keys";

export function useCreatorDrafts() {
  const queryClient = useQueryClient();
  const drafts = useQuery({ queryKey: workflowQueryKeys.drafts(), queryFn: listDrafts, retry: false });
  const create = useMutation({
    mutationFn: () => createDraft({}),
    retry: false,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.drafts() }),
  });
  const attach = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => attachDraftArtifact(id, file),
    retry: false,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.drafts() }),
  });
  const submit = useMutation({
    mutationFn: (id: string) => submitDraft(id),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.drafts() });
      void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.mineRoot() });
    },
  });
  const remove = useMutation({
    mutationFn: deleteDraft,
    retry: false,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: workflowQueryKeys.drafts() }),
  });

  return { drafts, create, attach, submit, remove };
}
