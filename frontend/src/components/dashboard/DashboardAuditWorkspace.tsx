"use client";

import { ChevronLeft, ChevronRight, ClipboardList, Filter, ShieldCheck, UserRound } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";

import { adminApi, AdminIntegrationUnavailableError, type AdminAuditEvent } from "../../lib/api/admin";
import { ApiRequestError } from "../../lib/api/client";
import { adminQueryKeys } from "../../lib/api/query-keys";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { Button } from "../ui/button";
import { SearchInput } from "../ui/search-input";
import { SelectField, SelectItem } from "../ui/select";
import { StatusMessage } from "../ui/status";
import { DashboardFrame, DashboardLoading } from "./DashboardFrame";

const PAGE_SIZE_OPTIONS = [15, 25, 50];

function useHydrated(): boolean {
  return useSyncExternalStore(() => () => undefined, () => true, () => false);
}

function canViewAudit(user: { role?: string; permissions?: string[] } | null): boolean {
  return user?.role === "admin" || Boolean(user?.permissions?.includes("settings:read"));
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminIntegrationUnavailableError) return "The catalog management service is not available in this environment.";
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return "Your account does not have permission to view the audit log.";
    if (error.status >= 500) return "The service is temporarily unavailable. Try again in a moment.";
  }
  return "Something went wrong while loading the audit log.";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function readableAction(action: string): string {
  return action.split(/[._]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function outcomeClasses(outcome: string): string {
  if (outcome === "committed") return "bg-[var(--color-success)]";
  if (outcome === "failed" || outcome === "rejected") return "bg-[var(--color-danger)]";
  return "bg-[var(--color-text-muted)]";
}

function matchesEvent(event: AdminAuditEvent, search: string, outcome: string, action: string): boolean {
  if (outcome !== "all" && event.outcome !== outcome) return false;
  if (action !== "all" && event.action !== action) return false;
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [event.action, event.outcome, event.target_type, event.target_id, event.request_id, event.actor_user_id === null ? "system" : `user #${event.actor_user_id}`]
    .some((value) => value.toLowerCase().includes(query));
}

function AuditRows({ events }: { events: AdminAuditEvent[] }) {
  if (events.length === 0) return <p className="px-5 py-10 text-sm text-[var(--color-text-muted)]">No audit events match the current filters.</p>;
  return <ol className="divide-y divide-[var(--color-border)]" aria-label="Administrative audit events">{events.map((event) => <li key={event.event_id}>
    <Link href={`/dashboard/audit/${encodeURIComponent(event.event_id)}`} className="group grid gap-3 px-5 py-3.5 transition-colors hover:bg-[var(--color-surface-muted)] sm:px-6 lg:grid-cols-[11rem_minmax(0,1fr)_9rem_auto] lg:items-center lg:gap-5">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${outcomeClasses(event.outcome)}`} aria-hidden="true" />
        <div>
          <time dateTime={event.timestamp} className="text-[13px] font-semibold tabular-nums text-[var(--color-text)]">{formatTimestamp(event.timestamp)}</time>
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold group-hover:text-[var(--color-primary-strong)]">{readableAction(event.action)}</h3>
          <span className={`text-xs font-semibold ${event.outcome === "committed" ? "text-[var(--color-success-foreground)]" : event.outcome === "failed" || event.outcome === "rejected" ? "text-[var(--color-danger-foreground)]" : "text-[var(--color-text-muted)]"}`}>{readableAction(event.outcome)}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]"><span className="font-medium text-[var(--color-text)]">{event.target_type}</span><span className="mx-1">/</span>{event.target_id}</p>
      </div>
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <UserRound aria-hidden="true" className="size-3.5 shrink-0" />
        <span>{event.actor_user_id === null ? "System" : `User #${event.actor_user_id}`}</span>
      </div>
      <ChevronRight aria-hidden="true" className="hidden size-4 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5 lg:block" />
    </Link>
  </li>)}</ol>;
}

function Pagination({ page, totalPages, pageSize, total, onPageChange, onPageSizeChange }: { page: number; totalPages: number; pageSize: number; total: number; onPageChange: (page: number) => void; onPageSizeChange: (pageSize: string) => void }) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return <nav className="flex flex-col gap-4 border-t border-[var(--color-border)] px-5 py-3.5 text-xs text-[var(--color-text-muted)] sm:flex-row sm:items-end sm:justify-between sm:px-6" aria-label="Audit pagination">
    <div className="flex flex-wrap items-end gap-4">
      <span className="pb-2">Showing <strong className="text-[var(--color-text)]">{first}–{last}</strong> of <strong className="text-[var(--color-text)]">{total}</strong></span>
      <div className="w-36"><SelectField compact label="Results per page" name="audit-page-size" value={String(pageSize)} onValueChange={onPageSizeChange}>{PAGE_SIZE_OPTIONS.map((value) => <SelectItem key={value} value={String(value)}>Show {value} results</SelectItem>)}</SelectField></div>
    </div>
    <div className="flex items-center gap-2">
      <Button type="button" variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft aria-hidden="true" className="size-3.5" />Previous</Button>
      <span className="min-w-20 text-center tabular-nums">Page {page} of {totalPages}</span>
      <Button type="button" variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next<ChevronRight aria-hidden="true" className="size-3.5" /></Button>
    </div>
  </nav>;
}

export function DashboardAuditWorkspace() {
  const hydrated = useHydrated();
  const current = useCurrentUser();
  const user = current.user;
  const allowed = canViewAudit(user);
  const audit = useQuery({ queryKey: adminQueryKeys.audit(200), queryFn: () => adminApi.listAudit(200), enabled: allowed, retry: false });
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [action, setAction] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("15");
  const events = useMemo(() => audit.data?.events ?? [], [audit.data?.events]);
  const pageSizeValue = Number(pageSize);
  const outcomes = useMemo(() => Array.from(new Set(events.map((event) => event.outcome))).sort(), [events]);
  const actions = useMemo(() => Array.from(new Set(events.map((event) => event.action))).sort(), [events]);
  const filteredEvents = useMemo(() => events.filter((event) => matchesEvent(event, search, outcome, action)), [action, events, outcome, search]);
  const totalPages = Math.max(1, Math.ceil(filteredEvents.length / pageSizeValue));
  const currentPage = Math.min(page, totalPages);
  const visibleEvents = filteredEvents.slice((currentPage - 1) * pageSizeValue, currentPage * pageSizeValue);
  const hasFilters = Boolean(search || outcome !== "all" || action !== "all");

  function resetPage() {
    setPage(1);
  }

  function clearFilters() {
    setSearch("");
    setOutcome("all");
    setAction("all");
    resetPage();
  }

  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view the audit log.</StatusMessage></DashboardFrame>;
  if (!allowed) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Your account does not have permission to view the audit log.</StatusMessage></DashboardFrame>;

  return (
    <DashboardFrame canSubmit={Boolean(user.permissions?.includes("catalog:submit"))}>
      <div className="space-y-6">
        <header className="flex flex-col justify-between gap-4 border-b border-[var(--color-border)] pb-5 sm:flex-row sm:items-end">
          <div>
            <p className="technical-label text-[var(--color-primary)]">Governance</p>
            <h1 className="mt-1.5 text-2xl font-bold tracking-tight">Audit trail</h1>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-5 text-[var(--color-text-muted)]">Review administrative activity across the Store workspace.</p>
          </div>
          <div className="flex items-center gap-2.5 text-sm text-[var(--color-text-muted)]">
            <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><ShieldCheck aria-hidden="true" className="size-4" /></span>
            <span><strong className="block text-[13px] text-[var(--color-text)]">{events.length} events</strong><span className="text-[11px]">Latest activity first</span></span>
          </div>
        </header>

        {audit.error && <StatusMessage tone="danger" className="p-4">{errorMessage(audit.error)}</StatusMessage>}
        {audit.isPending ? <DashboardLoading /> : <section className="surface-card overflow-hidden" aria-labelledby="audit-history-heading">
          <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]/45 px-5 py-4 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5">
                <span className="grid size-7 place-items-center rounded-md bg-[var(--color-surface)] text-[var(--color-text-muted)]"><ClipboardList aria-hidden="true" className="size-3.5" /></span>
                <div><h2 id="audit-history-heading" className="text-sm font-bold">Administrative activity</h2><p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">Select an event to inspect its full context.</p></div>
              </div>
              <span className="text-xs font-semibold text-[var(--color-text-muted)]">{filteredEvents.length} results</span>
            </div>
            <div className="mt-4 grid gap-2.5 md:grid-cols-[minmax(16rem,1.5fr)_minmax(9rem,.7fr)_minmax(10rem,.8fr)_7rem_auto] md:items-end">
              <label className="grid gap-1.5 text-xs font-semibold" htmlFor="audit-search">
                <span className="flex items-center gap-1.5"><Filter aria-hidden="true" className="size-3.5 text-[var(--color-primary)]" />Search events</span>
                <SearchInput id="audit-search" aria-label="Search audit events" placeholder="Action, target, actor or request ID" value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} onClear={() => { setSearch(""); resetPage(); }} />
              </label>
              <SelectField label="Outcome" name="audit-outcome" value={outcome} onValueChange={(value) => { setOutcome(value); resetPage(); }}><SelectItem value="all">All outcomes</SelectItem>{outcomes.map((value) => <SelectItem key={value} value={value}>{readableAction(value)}</SelectItem>)}</SelectField>
              <SelectField label="Action" name="audit-action" value={action} onValueChange={(value) => { setAction(value); resetPage(); }}><SelectItem value="all">All actions</SelectItem>{actions.map((value) => <SelectItem key={value} value={value}>{readableAction(value)}</SelectItem>)}</SelectField>
              {hasFilters && <Button type="button" variant="ghost" size="sm" className="mb-0.5 justify-self-start px-2 text-xs md:justify-self-end" onClick={clearFilters}>Clear</Button>}
            </div>
          </div>
          <AuditRows events={visibleEvents} />
          <Pagination page={currentPage} totalPages={totalPages} pageSize={pageSizeValue} total={filteredEvents.length} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); resetPage(); }} />
        </section>}
      </div>
    </DashboardFrame>
  );
}
