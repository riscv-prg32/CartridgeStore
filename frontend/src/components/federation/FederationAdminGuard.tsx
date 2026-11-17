"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { authErrorMessage } from "../../lib/api/auth";
import { authIntegrationEnabled } from "../../lib/auth/config";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { StatusMessage } from "../ui/status";

export function hasFederationPermission(user: { permissions?: string[] } | null, permission: "federation:read" | "federation:manage") {
  return user?.permissions?.includes(permission) ?? false;
}

export function FederationAdminGuard({ children }: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const current = useCurrentUser();

  useEffect(() => {
    if (authIntegrationEnabled && !current.isPending && !current.error && !current.user) {
      router.replace(`/login?reason=required&return_to=${encodeURIComponent(pathname || "/admin/federation")}`);
    }
  }, [current.error, current.isPending, current.user, pathname, router]);

  if (!authIntegrationEnabled) return <Message title="Federation administration is disabled" detail="Enable the isolated authentication integration in development to use this area." />;
  if (current.isPending) return <Message title="Checking your session…" />;
  if (current.error) return <Message title="Unable to check your session" detail={authErrorMessage(current.error, "session")} error />;
  if (!current.user) return <Message title="Redirecting to sign in…" />;
  if (!hasFederationPermission(current.user, "federation:read")) {
    return <Message title="Federation administration is not available" detail="Your account does not have federation:read permission." error />;
  }
  return children;
}

function Message({ title, detail, error = false }: { title: string; detail?: string; error?: boolean }) {
  return <main className="mx-auto max-w-6xl px-6 py-12"><StatusMessage tone={error ? "danger" : "muted"} className="rounded-xl p-6"><h1 className="text-xl font-semibold">{title}</h1>{detail && <p className="mt-2 text-sm opacity-80">{detail}</p>}</StatusMessage></main>;
}
