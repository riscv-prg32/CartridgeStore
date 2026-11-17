"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { authErrorMessage } from "../../lib/api/auth";
import { authIntegrationEnabled } from "../../lib/auth/config";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { StatusMessage } from "../ui/status";

export function ProtectedRoute({ children }: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const current = useCurrentUser();

  useEffect(() => {
    if (authIntegrationEnabled && !current.isPending && !current.error && !current.user) {
      router.replace(`/login?reason=required&return_to=${encodeURIComponent(pathname || "/")}`);
    }
  }, [current.error, current.isPending, current.user, pathname, router]);

  if (!authIntegrationEnabled) {
    return <main className="mx-auto max-w-3xl px-6 py-12"><p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-6">The isolated authentication integration is disabled.</p></main>;
  }
  if (current.isPending || (!current.user && !current.error)) {
    return <main className="mx-auto max-w-3xl px-6 py-12" aria-busy="true">Checking your session…</main>;
  }
  if (current.error) {
    return <main className="mx-auto max-w-3xl px-6 py-12"><StatusMessage tone="danger" className="p-6">{authErrorMessage(current.error, "session")}</StatusMessage></main>;
  }
  if (!current.user) return <main className="mx-auto max-w-3xl px-6 py-12">Redirecting to sign in…</main>;
  return children;
}
