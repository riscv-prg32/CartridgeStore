"use client";

import Link from "next/link";
import { type FormEvent } from "react";

import { authIntegrationEnabled } from "../../../lib/auth/config";
import { Button } from "../../ui/button";
import { Field } from "../../ui/input";
import { StatusMessage } from "../../ui/status";
import { registrationErrorMessage, useRegistration } from "./use-registration";

type RegistrationFormProps = {
  complete: boolean;
  initialToken: string;
};

export function RegistrationForm({ complete, initialToken }: RegistrationFormProps) {
  const state = useRegistration(complete, initialToken);

  if (!authIntegrationEnabled) {
    return <main className="page-gutter flex min-h-[calc(100vh-4rem)] items-center py-12"><section className="surface-card mx-auto w-full max-w-2xl p-6 sm:p-8"><p className="technical-label text-[var(--color-primary)]">Development integration</p><h1 className="mt-2 text-3xl font-bold">Registration unavailable</h1><p className="mt-3 text-[var(--color-text-muted)]">The isolated Fastify authentication integration is disabled in this environment.</p></section></main>;
  }

  if (state.registration.data) {
    return <main className="page-gutter flex min-h-[calc(100vh-4rem)] items-center py-12"><section className="mx-auto w-full max-w-2xl rounded-md border border-emerald-300 bg-emerald-50 p-6 text-emerald-950 sm:p-8"><p className="technical-label text-emerald-700">Account setup</p><h1 className="mt-2 text-3xl font-bold">Check your email</h1><p className="mt-3">If registration is enabled, a one-time completion link was issued for {state.registration.data.email}.</p><Link className="mt-6 inline-block font-semibold underline" href="/login">Return to sign in</Link></section></main>;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    state.submit();
  }

  const error = state.registration.error ?? state.completion.error;
  return (
    <main className="page-gutter flex min-h-[calc(100vh-4rem)] items-center py-8 sm:py-12">
      <section className="surface-card mx-auto w-full max-w-2xl p-6 sm:p-8">
        <p className="technical-label text-[var(--color-primary)]">PRG32 Cartridge Store / Account</p>
        <h1 className="mt-2 text-3xl font-bold">{complete ? "Complete registration" : "Create an account"}</h1>
        <p className="mt-3 text-[var(--color-text-muted)]">{complete ? "Open the one-time link to activate your account." : "Choose your account name and password. We will send a one-time verification link."}</p>
        <form className="mt-8 max-w-xl space-y-5" onSubmit={submit}>
          {complete ? <>
            <Field label="Registration token" id="registration-token" name="token" value={state.token} onChange={(event) => state.setToken(event.target.value)} required autoComplete="off" />
            <Field label="Password" id="registration-password" name="password" type="password" value={state.password} onChange={(event) => state.setPassword(event.target.value)} required autoComplete="new-password" />
            <Field label="Confirm password" id="registration-confirmation" name="password-confirm" type="password" value={state.confirmation} onChange={(event) => state.setConfirmation(event.target.value)} required autoComplete="new-password" />
          </> : <>
            <Field label="Username" id="registration-username" name="username" value={state.username} onChange={(event) => state.setUsername(event.target.value)} required autoComplete="username" maxLength={80} />
            <Field label="Email" id="registration-email" name="email" type="email" value={state.email} onChange={(event) => state.setEmail(event.target.value)} required autoComplete="email" />
            <Field label="Password" id="registration-password" name="password" type="password" value={state.password} onChange={(event) => state.setPassword(event.target.value)} required autoComplete="new-password" />
            <Field label="Confirm password" id="registration-confirmation" name="password-confirm" type="password" value={state.confirmation} onChange={(event) => state.setConfirmation(event.target.value)} required autoComplete="new-password" />
          </>}
          {error && <StatusMessage tone="danger">{registrationErrorMessage(error)}</StatusMessage>}
          <Button type="submit" loading={state.registration.isPending || state.completion.isPending}>{complete ? (state.completion.isPending ? "Completing…" : "Complete registration") : (state.registration.isPending ? "Requesting…" : "Request verification email")}</Button>
        </form>
        <p className="mt-6 text-sm text-[var(--color-text-muted)]"><Link className="font-semibold text-[var(--color-primary-strong)] underline" href="/login">Return to sign in</Link></p>
      </section>
    </main>
  );
}
