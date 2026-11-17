"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { authErrorMessage } from "../../lib/api/auth";
import { authIntegrationEnabled } from "../../lib/auth/config";
import { safeReturnPath } from "../../lib/auth/return-path";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { cn } from "../../lib/cn";
import { StatusMessage } from "../ui/status";
import { FederatedLoginOptions } from "./federation/FederatedLoginOptions";
import { LocalLoginForm } from "./local/LocalLoginForm";
import { PasskeyLogin } from "./passkeys/PasskeyLogin";

type LoginPanelProps = {
  enabled?: boolean;
};

export function LoginPanel({ enabled = authIntegrationEnabled }: LoginPanelProps) {
  const searchParams = useSearchParams();
  const [passkeyUsername, setPasskeyUsername] = useState("");
  const returnTo = useMemo(() => {
    const requestedReturnTo = searchParams.get("return_to");
    return requestedReturnTo === null ? "/dashboard" : safeReturnPath(requestedReturnTo);
  }, [searchParams]);
  const reason = searchParams.get("reason");
  const current = useCurrentUser(enabled);

  if (!enabled) {
    return (
      <main className="page-gutter flex min-h-[calc(100vh-4rem)] items-center py-12">
        <section className="surface-card mx-auto w-full max-w-2xl p-6 sm:p-8" aria-labelledby="auth-disabled-title">
          <p className="technical-label text-[var(--color-primary)]">Development integration</p>
          <h1 id="auth-disabled-title" className="mt-2 text-3xl font-bold tracking-tight">Authentication is disabled</h1>
          <p className="mt-3 text-[var(--color-text-muted)]">The isolated Fastify authentication target is not enabled in this environment.</p>
          <Link className="mt-6 inline-flex text-sm font-semibold text-violet-700 underline-offset-4 hover:underline" href="/">Return to the store</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="page-gutter flex min-h-[calc(100vh-4rem)] items-center py-8 sm:py-12">
      <section
        className={cn(
          "mx-auto grid w-full max-w-5xl overflow-hidden rounded-xl border",
          "border-[var(--color-border)] bg-[var(--color-surface)]",
          "shadow-[var(--shadow-card)]",
          "md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]",
        )}
        aria-labelledby="login-title"
      >
        <div className="p-6 sm:p-10">
          <p className="technical-label text-[var(--color-primary)]">PRG32 Cartridge Store / Account</p>
          <h1 id="login-title" className="mt-2 text-3xl font-bold tracking-tight">Sign in</h1>
          <p className="mt-3 max-w-md text-[var(--color-text-muted)]">Use your Cartridge Store account to continue.</p>

          {reason === "expired" && <StatusMessage tone="warning" className="mt-5">Your session expired. Please sign in again.</StatusMessage>}
          {reason === "required" && <StatusMessage tone="warning" className="mt-5">Sign in is required to view that page.</StatusMessage>}
          {current.error && <StatusMessage tone="danger" className="mt-5">{authErrorMessage(current.error, "session")}</StatusMessage>}

          <LocalLoginForm returnTo={returnTo} onUsernameChange={setPasskeyUsername} />
          <PasskeyLogin returnTo={returnTo} username={passkeyUsername} />
        </div>

        <FederatedLoginOptions enabled={enabled} returnTo={returnTo} />
      </section>
    </main>
  );
}
