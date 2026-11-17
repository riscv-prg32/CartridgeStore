"use client";

import { useCurrentUser } from "../../lib/auth/use-current-user";
import { AccountWorkspace } from "../account/AccountWorkspace";
import { DashboardFrame } from "./DashboardFrame";

/** Renders account management inside the dashboard shell. */
export function DashboardAccountWorkspace() {
  const current = useCurrentUser();
  const canSubmit = Boolean(current.user?.permissions?.includes("catalog:submit"));

  return (
    <DashboardFrame canSubmit={canSubmit}>
      <AccountWorkspace />
    </DashboardFrame>
  );
}
