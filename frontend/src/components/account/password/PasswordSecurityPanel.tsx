"use client";

import { Button } from "../../ui/button";
import { Field } from "../../ui/input";
import { StatusMessage } from "../../ui/status";
import { usePasswordSecurity } from "./use-password-security";

export function PasswordSecurityPanel() {
  const { currentPassword, setCurrentPassword, password, setPassword, passwordConfirm, setPasswordConfirm, mutation } = usePasswordSecurity();
  return <section className="surface-card p-5 sm:p-6" aria-labelledby="password-heading"><div className="flex flex-col gap-1 border-b border-[var(--color-border)] pb-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 id="password-heading" className="text-lg font-bold">Password</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Changing it signs out other active sessions.</p></div><span className="technical-label text-[var(--color-text-muted)]">Security</span></div><form className="mt-5 grid gap-4 sm:grid-cols-3" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><Field label="Current password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /><Field label="New password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /><Field label="Confirm password" type="password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} autoComplete="new-password" required /><Button className="sm:col-span-3 sm:justify-self-start" type="submit" loading={mutation.isPending}>Change password</Button></form>{mutation.data && <StatusMessage tone="success" className="mt-3 border-0 bg-transparent px-0 py-0">Password changed and other sessions were signed out.</StatusMessage>}{mutation.error && <StatusMessage tone="danger" className="mt-3 border-0 bg-transparent px-0 py-0">Password change failed. Check the current password and confirmation.</StatusMessage>}</section>;
}
