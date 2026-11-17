"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { completePasswordReset } from "../../lib/api/auth";
import { Button } from "../../components/ui/button";

export default function PasswordResetPage() {
  const params = useSearchParams();
  const [token, setToken] = useState(params.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const mutation = useMutation({ mutationFn: () => completePasswordReset(token.trim(), password, confirmation) });
  return <main className="page-gutter flex min-h-[calc(100vh-4rem)] items-center py-12"><section className="surface-card mx-auto w-full max-w-xl p-6 sm:p-8"><p className="technical-label text-[var(--color-primary)]">Account recovery</p><h1 className="mt-2 text-3xl font-bold">Reset password</h1>{mutation.data ? <p className="mt-5 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800">Password reset complete. <Link className="font-semibold underline" href="/login">Sign in</Link>.</p> : <form className="mt-6 space-y-4" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><label className="grid gap-2 text-sm font-semibold">Reset token<input className="min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-normal" value={token} onChange={(event) => setToken(event.target.value)} required autoComplete="off" /></label><label className="grid gap-2 text-sm font-semibold">New password<input className="min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-normal" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" /></label><label className="grid gap-2 text-sm font-semibold">Confirm password<input className="min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-normal" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required autoComplete="new-password" /></label>{mutation.error && <p className="text-sm text-rose-700" role="alert">This reset link is invalid, expired, or already used.</p>}<Button type="submit" loading={mutation.isPending}>Reset password</Button></form>}<Link className="mt-6 inline-block text-sm font-semibold text-[var(--color-primary-strong)] underline" href="/login">Return to sign in</Link></section></main>;
}
