"use client";

import { ArrowLeft, ArrowRight, CheckCircle2, Clipboard, ClipboardCheck, Clock3, FileSearch, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

import { adminApi, AdminIntegrationUnavailableError, type AdminAuditChange, type AdminAuditEvent } from "../../lib/api/admin";
import { ApiRequestError } from "../../lib/api/client";
import { adminQueryKeys } from "../../lib/api/query-keys";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { Button } from "../ui/button";
import { StatusMessage } from "../ui/status";
import { DashboardFrame, DashboardLoading } from "./DashboardFrame";

function useHydrated(): boolean {
  return useSyncExternalStore(() => () => undefined, () => true, () => false);
}

function canViewAudit(user: { role?: string; permissions?: string[] } | null): boolean {
  return user?.role === "admin" || Boolean(user?.permissions?.includes("settings:read"));
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminIntegrationUnavailableError) return "The catalog management service is not available in this environment.";
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return "Your account does not have permission to view this audit event.";
    if (error.status === 404) return "This audit event could not be found.";
  }
  return "Something went wrong while loading this audit event.";
}

function readable(value: string): string {
  return value.split(/[._-]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en", { dateStyle: "full", timeStyle: "medium" }).format(date);
}

function SummaryValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-[var(--color-text-muted)]">Not provided</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return <span className="break-words">{String(value)}</span>;
  if (Array.isArray(value)) return value.length === 0 ? <span className="text-[var(--color-text-muted)]">None</span> : <ul className="space-y-2">{value.map((item, index) => <li key={index} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2"><SummaryValue value={item} /></li>)}</ul>;
  if (typeof value === "object") return <dl className="space-y-3">{Object.entries(value as Record<string, unknown>).map(([key, item]) => <div key={key} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"><dt className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">{readable(key)}</dt><dd className="min-w-0"><SummaryValue value={item} /></dd></div>)}</dl>;
  return <span>{String(value)}</span>;
}

function Outcome({ outcome }: { outcome: string }) {
  const committed = outcome === "committed";
  const rejected = outcome === "rejected" || outcome === "failed";
  const Icon = committed ? CheckCircle2 : rejected ? XCircle : Clock3;
  const classes = committed ? "border-[var(--color-success)]/40 bg-[var(--color-success-soft)] text-[var(--color-success-foreground)]" : rejected ? "border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] text-[var(--color-danger-foreground)]" : "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]";
  return <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${classes}`}><Icon aria-hidden="true" className="size-4" />{readable(outcome)}</span>;
}

function CopyRequestId({ requestId }: { requestId: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]" onClick={() => { void navigator.clipboard?.writeText(requestId).then(() => setCopied(true)); }}><span className="sr-only">Copy request ID</span>{copied ? <ClipboardCheck aria-hidden="true" className="size-3.5" /> : <Clipboard aria-hidden="true" className="size-3.5" />}{copied ? "Copied" : "Copy ID"}</button>;
}

function isAuditChange(value: unknown): value is AdminAuditChange {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  return typeof change.key === "string" && "before" in change && "after" in change;
}

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (typeof value === "string") return value || "Empty";
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value);
  if (Array.isArray(value)) return value.length > 0 ? value.map((item) => formatAuditValue(item)).join(", ") : "None";
  if (typeof value === "object") {
    const redacted = value as { redacted?: unknown; configured?: unknown };
    if (redacted.redacted === true) return redacted.configured === true ? "Configured" : "Not configured";
    return JSON.stringify(value);
  }
  return String(value);
}

function SettingsChangeList({ changes }: { changes: AdminAuditChange[] }) {
  return <ul className="mt-4 space-y-2" aria-label="Changed settings">{changes.map((change) => <li key={change.key} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-3"><p className="text-sm font-semibold">{change.key}</p><div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center"><div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-danger-foreground)]">Previous</p><p className="mt-1 break-words text-sm text-[var(--color-danger-foreground)]">{formatAuditValue(change.before)}</p></div><ArrowRight aria-hidden="true" className="hidden size-4 text-[var(--color-text-muted)] sm:block" /><div className="rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success-soft)] px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-success-foreground)]">New value</p><p className="mt-1 break-words text-sm font-semibold text-[var(--color-success-foreground)]">{formatAuditValue(change.after)}</p></div></div></li>)}</ul>;
}

function LegacySettingsSummary({ keys }: { keys: string[] }) {
  return <section><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Historical settings update</h3><div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 p-4"><p className="text-sm font-semibold">Before/after values are not available</p><p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">This event was recorded before value-level change tracking was enabled. The audit record contains the fields submitted by the form, but not the values that were actually different.</p><div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--color-border)] pt-3 text-sm"><span className="text-[var(--color-text-muted)]">Recorded fields</span><span className="font-semibold">{keys.length}</span></div></div><details className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"><summary className="cursor-pointer text-sm font-semibold">Show recorded field names</summary><ul className="mt-3 flex flex-wrap gap-2">{keys.map((key) => <li key={key} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5 font-mono text-xs text-[var(--color-text-muted)]">{key}</li>)}</ul></details></section>;
}

function EventSummary({ event }: { event: AdminAuditEvent }) {
  const entries = event.summary ? Object.entries(event.summary) : [];
  if (entries.length === 0) return <p className="text-sm text-[var(--color-text-muted)]">This event has no additional summary data.</p>;
  if (event.action === "settings.update" && Array.isArray(event.summary?.changes)) {
    const changes = event.summary.changes.filter(isAuditChange);
    if (changes.length > 0) return <section><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">Changed settings</h3><p className="mt-2 text-sm text-[var(--color-text-muted)]">Each row shows the effective value before and after this operation.</p><SettingsChangeList changes={changes} /></section>;
  }
  if (event.action === "settings.update" && Array.isArray(event.summary?.keys)) {
    const keys = event.summary.keys.filter((key): key is string => typeof key === "string");
    return <LegacySettingsSummary keys={keys} />;
  }
  return <div className="space-y-5">{entries.map(([key, value]) => <section key={key} className="border-b border-[var(--color-border)] pb-5 last:border-0 last:pb-0"><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{readable(key)}</h3><div className="mt-3 text-sm leading-6"><SummaryValue value={value} /></div></section>)}</div>;
}

export function DashboardAuditEventWorkspace() {
  const hydrated = useHydrated();
  const current = useCurrentUser();
  const params = useParams<{ eventId: string }>();
  const eventId = typeof params.eventId === "string" ? decodeURIComponent(params.eventId) : "";
  const user = current.user;
  const allowed = canViewAudit(user);
  const eventQuery = useQuery({ queryKey: adminQueryKeys.auditEvent(eventId || null), queryFn: () => adminApi.getAuditEvent(eventId), enabled: allowed && eventId.length > 0, retry: false });

  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view this audit event.</StatusMessage></DashboardFrame>;
  if (!allowed) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Your account does not have permission to view this audit event.</StatusMessage></DashboardFrame>;

  const event = eventQuery.data?.event;
  return <DashboardFrame canSubmit={Boolean(user.permissions?.includes("catalog:submit"))}><div className="space-y-8"><header className="border-b border-[var(--color-border)] pb-6"><Link href="/dashboard/audit" className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--color-primary-strong)] hover:underline"><ArrowLeft aria-hidden="true" className="size-4" />Back to audit trail</Link><div className="mt-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="technical-label text-[var(--color-primary)]">Governance / Event detail</p><h1 className="mt-2 text-3xl font-bold tracking-tight">{event ? readable(event.action) : "Audit event"}</h1><p className="mt-2 text-sm text-[var(--color-text-muted)]">Inspect the operation context and human-readable summary.</p></div><span className="hidden size-11 place-items-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)] sm:grid"><FileSearch aria-hidden="true" className="size-5" /></span></div></header>{eventQuery.error && <StatusMessage tone="danger" className="p-4">{errorMessage(eventQuery.error)}</StatusMessage>}{eventQuery.isPending ? <DashboardLoading /> : !event ? <StatusMessage tone="warning" className="p-5">This audit event could not be found.</StatusMessage> : <><section className="surface-card p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 border-b border-[var(--color-border)] pb-5 sm:flex-row sm:items-center"><div><p className="technical-label text-[var(--color-primary)]">Operation outcome</p><div className="mt-2"><Outcome outcome={event.outcome} /></div></div><time className="text-sm text-[var(--color-text-muted)]" dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time></div><dl className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4"><div><dt className="technical-label text-[var(--color-text-muted)]">Action</dt><dd className="mt-1 font-semibold">{readable(event.action)}</dd></div><div><dt className="technical-label text-[var(--color-text-muted)]">Actor</dt><dd className="mt-1 font-semibold">{event.actor_user_id === null ? "System" : `User #${event.actor_user_id}`}</dd></div><div><dt className="technical-label text-[var(--color-text-muted)]">Target</dt><dd className="mt-1 break-all font-semibold">{event.target_type} / {event.target_id}</dd></div><div><dt className="technical-label text-[var(--color-text-muted)]">Request ID</dt><dd className="mt-1 flex items-center gap-2"><span className="min-w-0 truncate font-mono text-xs">{event.request_id}</span><CopyRequestId requestId={event.request_id} /></dd></div></dl></section><section className="surface-card p-5 sm:p-6" aria-labelledby="event-summary-heading"><div className="mb-6 flex items-start gap-3"><span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><FileSearch aria-hidden="true" className="size-4" /></span><div><p className="technical-label text-[var(--color-primary)]">Event context</p><h2 id="event-summary-heading" className="mt-1 text-lg font-bold">Operation details</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">Structured information recorded for this administrative operation.</p></div></div><EventSummary event={event} /></section></>}</div></DashboardFrame>;
}
