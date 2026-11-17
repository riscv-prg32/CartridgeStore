"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { getWorkflowPrincipal, workflowErrorMessage } from "../../lib/api/workflow";
import { workflowQueryKeys } from "../../lib/api/query-keys";
import { authIntegrationEnabled } from "../../lib/auth/config";
import { StatusMessage, type StatusTone } from "../ui/status";

export function useWorkflowPrincipal() {
  return useQuery({
    queryKey: workflowQueryKeys.principal(),
    queryFn: getWorkflowPrincipal,
    enabled: authIntegrationEnabled,
    retry: false,
    staleTime: 30_000,
  });
}

export function WorkflowGuard({
  children,
  permission,
}: Readonly<{ children: ReactNode; permission?: string }>) {
  const current = useWorkflowPrincipal();

  if (!authIntegrationEnabled) {
    return <WorkflowMessage tone="muted">The isolated workflow integration is disabled.</WorkflowMessage>;
  }
  if (current.isPending) {
    return <WorkflowMessage>Checking workflow authorization…</WorkflowMessage>;
  }
  if (current.error) {
    return <WorkflowMessage tone="error">{workflowErrorMessage(current.error)}</WorkflowMessage>;
  }
  if (!current.data?.user.authenticated) {
    return <WorkflowMessage tone="warning">Sign in is required to use this workflow.</WorkflowMessage>;
  }
  if (permission && !current.data.user.permissions?.includes(permission)) {
    return <WorkflowMessage tone="warning">You are not authorized for this workflow.</WorkflowMessage>;
  }
  return children;
}

export function WorkflowMessage({
  children,
  tone = "muted",
}: Readonly<{ children: ReactNode; tone?: "muted" | "warning" | "error" }>) {
  const mappedTone: StatusTone = tone === "error" ? "danger" : tone;
  return <StatusMessage tone={mappedTone} className="p-5">{children}</StatusMessage>;
}
