"use client";

import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { requestPasswordReset } from "../../lib/api/auth";
import { Button } from "../../components/ui/button";

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const mutation = useMutation({ mutationFn: () => requestPasswordReset(identifier.trim()) });
  return <main className="page-gutter flex min-h-[calc(100vh-4rem)] items-center py-12"><section className="surface-card mx-auto w-full max-w-xl p-6 sm:p-8"><p className="technical-label text-[var(--color-primary)]">Account recovery</p><h1 className="mt-2 text-3xl font-bold">Forgot password</h1><p className="mt-2 text-sm text-[var(--color-text-muted)]">Request a one-time reset link without revealing whether an account exists.</p>{mutation.data ? <p className="mt-5 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800">If the account is eligible, a reset link has been sent.</p> : <form className="mt-6 space-y-4" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><label className="grid gap-2 text-sm font-semibold">Email or username<input className="min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-normal" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required autoComplete="username" /></label>{mutation.error && <p className="text-sm text-rose-700" role="alert">The reset request could not be completed.</p>}<Button type="submit" loading={mutation.isPending}>Send reset link</Button></form>}<Link className="mt-6 inline-block text-sm font-semibold text-[var(--color-primary-strong)] underline" href="/login">Return to sign in</Link></section></main>;
}
