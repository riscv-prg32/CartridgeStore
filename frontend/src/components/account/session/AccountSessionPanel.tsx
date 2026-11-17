"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import type { Principal } from "../../../lib/api/contracts";
import { authQueryKeys } from "../../../lib/api/query-keys";
import { removeSensitiveQueryData } from "../../../lib/auth/query-cache";
import { Badge } from "../../ui/badge";

export function AccountSessionPanel({ user }: { user: Principal }) {
  const displayName = user.name?.trim() || user.username;
  return (
    <header className="border-b border-[var(--color-border)] pb-6">
      <p className="technical-label text-[var(--color-primary)]">
        Personal space
      </p>
      <div className="mt-2 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your account</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">
            Manage access, security credentials, and API clients from one place.
          </p>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            Signed in as <strong>{displayName}</strong> · {user.email}
          </p>
        </div>
        <Badge variant="success">Session active</Badge>
      </div>
    </header>
  );
}

export function ReauthenticateButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return (
    <div className="border-t border-[var(--color-border)] pt-2">
      <button
        className="text-sm font-semibold text-[var(--color-primary-strong)] underline underline-offset-4"
        type="button"
        onClick={() => {
          removeSensitiveQueryData(queryClient);
          queryClient.removeQueries({ queryKey: authQueryKeys.currentUser() });
          router.replace("/login");
        }}
      >
        Re-authenticate
      </button>
    </div>
  );
}
