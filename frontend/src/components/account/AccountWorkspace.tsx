"use client";

import { useCurrentUser } from "../../lib/auth/use-current-user";
import { AccountError } from "./account-ui";
import { AccountSessionPanel, ReauthenticateButton } from "./session/AccountSessionPanel";
import { PasswordSecurityPanel } from "./password/PasswordSecurityPanel";
import { ApiTokensPanel } from "./tokens/ApiTokensPanel";
import { PasskeysPanel } from "./passkeys/PasskeysPanel";
import { ProfileDetailsPanel } from "./profile/ProfileDetailsPanel";

export function AccountWorkspace() {
  const current = useCurrentUser();
  if (current.isPending) return <div className="space-y-5 py-6" aria-busy="true"><div className="h-28 animate-pulse rounded-xl bg-[var(--color-surface)]" /><div className="h-56 animate-pulse rounded-xl bg-[var(--color-surface)]" /></div>;
  if (current.error) return <div className="py-6"><AccountError error={current.error} /></div>;
  if (!current.user) return <div className="py-6"><AccountError error={new Error("Authentication required.")} /></div>;
  return <div className="space-y-6"><AccountSessionPanel user={current.user} /><ProfileDetailsPanel user={current.user} /><PasswordSecurityPanel /><ApiTokensPanel key={current.user.id ?? "anonymous"} /><PasskeysPanel /><ReauthenticateButton /></div>;
}
