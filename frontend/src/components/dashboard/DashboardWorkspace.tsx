"use client";

import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowUpRight,
  BarChart3,
  Box,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  FileCode2,
  FolderKanban,
  PackageCheck,
  Rocket,
  Store,
  UploadCloud,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiRequestError } from "../../lib/api/client";
import { adminApi, AdminIntegrationUnavailableError, type AdminCartridge } from "../../lib/api/admin";
import { adminQueryKeys, workflowQueryKeys } from "../../lib/api/query-keys";
import { getSubmission, listDrafts, listMySubmissions, WorkflowIntegrationUnavailableError } from "../../lib/api/workflow";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import type { OwnedSubmissionSummary, PublisherDraft } from "../../lib/api/contracts";
import { CartridgeArtwork } from "../storefront/CartridgeArtwork";
import { DashboardFrame, DashboardLoading, PageHeader, useHydrated } from "./DashboardFrame";
import {
  SettingsPanel,
} from "../admin/settings/SettingsPanel";
import type { SettingsSectionId } from "../admin/settings/settings-sections";
import { Badge, type BadgeVariant } from "../ui/badge";
import { Button } from "../ui/button";
import { StatusMessage } from "../ui/status";

function errorMessage(error: unknown): string {
  if (error instanceof WorkflowIntegrationUnavailableError) return "The publishing workflow is not available in this environment.";
  if (error instanceof AdminIntegrationUnavailableError) return "The catalog management service is not available in this environment.";
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return "Sign in is required to load this dashboard.";
    if (error.status === 403) return "Your account does not have permission to view this section.";
    if (error.status >= 500) return "The service is temporarily unavailable. Try again in a moment.";
  }
  return "Something went wrong while loading the dashboard.";
}
function formatDate(value: string | null | undefined): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not yet";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

function submissionBadge(status: string): { label: string; variant: BadgeVariant } {
  if (status === "verified" || status === "published") return { label: "Published", variant: "published" };
  if (status === "rejected") return { label: "Changes requested", variant: "danger" };
  return { label: "In review", variant: "warning" };
}

function catalogBadge(action: AdminCartridge["moderation_action"]): { label: string; variant: BadgeVariant } {
  if (action === "unpublished") return { label: "Withdrawn", variant: "danger" };
  if (action === "hidden") return { label: "Hidden", variant: "warning" };
  return { label: "Live in store", variant: "published" };
}

function MetricStat({ label, value, detail, icon: Icon, tone = "neutral", href }: { label: string; value: number; detail: string; icon: LucideIcon; tone?: "neutral" | "primary" | "success" | "warning"; href?: string }) {
  const toneClass = tone === "primary" ? "text-[var(--color-primary-strong)]" : tone === "success" ? "text-emerald-700 dark:text-emerald-300" : tone === "warning" ? "text-amber-700 dark:text-amber-300" : "text-[var(--color-text-muted)]";
  return (
    <div className={`relative flex min-w-0 items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-[var(--color-text)] shadow-[var(--shadow-card)] sm:p-5 ${href ? "group cursor-pointer transition-colors hover:border-[var(--color-primary)]" : ""}`}>
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-surface-muted)] shadow-sm ${toneClass}`}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0">
        <dt className={`text-xs font-semibold uppercase tracking-[0.12em] ${toneClass}`}>{label}</dt>
        <dd className="mt-1 text-3xl font-bold tracking-tight text-[var(--color-text)]">{value}</dd>
        <p className="mt-1 truncate text-xs text-[var(--color-text-muted)]">{detail}</p>
      </div>
      {href && <Link href={href} aria-label={`View ${label.toLowerCase()}`} className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]"><span className="sr-only">View {label.toLowerCase()}</span></Link>}
    </div>
  );
}

function ActionCard({ href, eyebrow, title, description, icon: Icon, featured = false }: { href: string; eyebrow: string; title: string; description: string; icon: LucideIcon; featured?: boolean }) {
  return (
    <Link href={href} className={`group flex min-h-52 flex-col rounded-xl border p-5 shadow-[var(--shadow-card)] transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-card-hover)] sm:p-6 ${featured ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white" : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)]"}`}>
      <div className="flex items-start justify-between gap-4"><span className={`grid size-9 place-items-center rounded-lg ${featured ? "bg-white/15" : "bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"}`}><Icon aria-hidden="true" className="size-4" /></span><ArrowUpRight aria-hidden="true" className={`size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 ${featured ? "text-white/75" : "text-[var(--color-text-muted)]"}`} /></div>
      <p className={`mt-7 text-xs font-semibold uppercase tracking-[0.16em] ${featured ? "text-violet-100" : "text-[var(--color-primary)]"}`}>{eyebrow}</p>
      <h3 className="mt-2 text-lg font-bold">{title}</h3>
      <p className={`mt-2 text-sm leading-6 ${featured ? "text-violet-100" : "text-[var(--color-text-muted)]"}`}>{description}</p>
    </Link>
  );
}


const DASHBOARD_HERO_DISMISSED_KEY = "prg32-dashboard-overview-hero-dismissed";
const DASHBOARD_HERO_CHANGE_EVENT = "prg32-dashboard-overview-hero-change";

function readDashboardHeroDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DASHBOARD_HERO_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function useDashboardHeroDismissed(): readonly [boolean, () => void] {
  const dismissed = useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined") return () => undefined;
      const handleStorage = (event: StorageEvent) => {
        if (event.key === DASHBOARD_HERO_DISMISSED_KEY || event.key === null) onChange();
      };
      window.addEventListener("storage", handleStorage);
      window.addEventListener(DASHBOARD_HERO_CHANGE_EVENT, onChange);
      return () => {
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener(DASHBOARD_HERO_CHANGE_EVENT, onChange);
      };
    },
    readDashboardHeroDismissed,
    () => false,
  );

  const dismiss = () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DASHBOARD_HERO_DISMISSED_KEY, "true");
    } catch {
      // The banner still closes for this render when storage is unavailable.
    }
    window.dispatchEvent(new Event(DASHBOARD_HERO_CHANGE_EVENT));
  };

  return [dismissed, dismiss];
}

function SubmissionRow({ submission }: { submission: OwnedSubmissionSummary }) {
  const badge = submissionBadge(submission.status);
  return <li className="border-b border-[var(--color-border)] last:border-0"><Link href={`/dashboard/submissions/${submission.id}`} className="group flex w-full flex-col gap-2 px-5 py-4 transition-colors hover:bg-[var(--color-surface-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold group-hover:text-[var(--color-primary-strong)]">{submission.title}</h3><Badge variant={badge.variant}>{badge.label}</Badge></div><p className="mt-1 truncate text-sm text-[var(--color-text-muted)]">{submission.game_id} · v{submission.version}</p></div><div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]"><span>{formatDate(submission.reviewed_at ?? submission.created_at)}</span><ChevronRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" /></div></Link></li>;
}

function DraftRow({ draft }: { draft: PublisherDraft }) {
  return <li className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)] sm:flex-row sm:items-center sm:justify-between"><div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]"><FileCode2 aria-hidden="true" className="size-4" /></span><div className="min-w-0"><p className="truncate font-semibold">{draft.source_submission_id ? `Revision #${draft.source_submission_id}` : "New cartridge"}</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">{draft.has_artifact ? "Bundle attached" : "Bundle missing"} · updated {formatDate(draft.updated_at)}</p></div></div><div className="flex items-center justify-between gap-3 sm:justify-end"><Badge variant={draft.has_artifact ? "success" : "utility"}>{draft.status}</Badge><Button asChild size="sm" variant="secondary"><Link href="/dashboard/drafts">Open</Link></Button></div></li>;
}

function CatalogTable({ items, onModerate, pending }: { items: AdminCartridge[]; onModerate: (cartridge: AdminCartridge) => void; pending: boolean }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">Published cartridges and store visibility controls</caption><thead className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] text-xs uppercase tracking-[0.12em] text-[var(--color-text-muted)]"><tr><th scope="col" className="px-4 py-3 font-semibold">Cartridge</th><th scope="col" className="px-4 py-3 font-semibold">Status</th><th scope="col" className="px-4 py-3 font-semibold">Version</th><th scope="col" className="px-4 py-3 font-semibold">Targets</th><th scope="col" className="px-4 py-3 font-semibold">Updated</th><th scope="col" className="px-4 py-3 text-right font-semibold">Actions</th></tr></thead><tbody className="divide-y divide-[var(--color-border)]">{items.map((cartridge) => <CatalogTableRow key={`${cartridge.id}/${cartridge.selected_version}`} cartridge={cartridge} onModerate={onModerate} pending={pending} />)}</tbody></table></div>;
}

function CatalogTableRow({ cartridge, onModerate, pending }: { cartridge: AdminCartridge; onModerate: (cartridge: AdminCartridge) => void; pending: boolean }) {
  const badge = catalogBadge(cartridge.moderation_action);
  const withdrawn = cartridge.moderation_action === "unpublished";
  return <tr className="bg-[var(--color-surface)] transition-colors hover:bg-[var(--color-surface-muted)]"><th scope="row" className="px-4 py-3 font-normal"><Link href={`/dashboard/cartridges/${encodeURIComponent(cartridge.id)}?version=${encodeURIComponent(cartridge.selected_version)}`} aria-label={`Open ${cartridge.title} details`} className="group flex min-w-52 items-center gap-3"><CartridgeArtwork gameId={cartridge.id} version={cartridge.selected_version} kind="icon" alt={`${cartridge.title} icon`} className="size-11 shrink-0 rounded-md border border-[var(--color-border)] transition-colors group-hover:border-[var(--color-primary)]" /><div className="min-w-0"><p className="truncate font-semibold group-hover:text-[var(--color-primary-strong)]">{cartridge.title}</p><p className="mt-1 max-w-64 truncate text-xs text-[var(--color-text-muted)]">{cartridge.id}</p></div></Link></th><td className="px-4 py-3"><Badge variant={badge.variant}>{badge.label}</Badge></td><td className="whitespace-nowrap px-4 py-3 text-[var(--color-text-muted)]">v{cartridge.selected_version}</td><td className="px-4 py-3 text-xs text-[var(--color-text-muted)]">{cartridge.architectures.join(" · ")}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-[var(--color-text-muted)]">{formatDate(typeof cartridge.updated_at === "string" ? cartridge.updated_at : null)}</td><td className="px-4 py-3"><div className="flex justify-end gap-2"><Link href={`/dashboard/cartridges/${encodeURIComponent(cartridge.id)}?version=${encodeURIComponent(cartridge.selected_version)}`} className="rounded-md px-2.5 py-2 text-xs font-semibold text-[var(--color-primary-strong)] hover:bg-[var(--color-primary-soft)]">Open detail</Link><Button size="sm" variant={withdrawn ? "secondary" : "danger"} loading={pending} onClick={() => onModerate(cartridge)}>{withdrawn ? "Restore" : "Withdraw"}</Button></div></td></tr>;
}

export function DashboardWorkspace() {
  const hydrated = useHydrated();
  const [heroDismissed, dismissHero] = useDashboardHeroDismissed();
  const current = useCurrentUser();
  const user = current.user;
  const canSubmit = Boolean(user?.permissions?.includes("catalog:submit"));
  const canManageCatalog = Boolean(user?.permissions?.includes("catalog:metadata:write"));
  const drafts = useQuery({ queryKey: workflowQueryKeys.drafts(), queryFn: listDrafts, enabled: canSubmit, retry: false });
  const submissions = useQuery({ queryKey: workflowQueryKeys.mine(1), queryFn: () => listMySubmissions(undefined, 1, 8), enabled: canSubmit, retry: false });
  const catalog = useQuery({ queryKey: adminQueryKeys.catalog({ moderation: true }), queryFn: () => adminApi.listModerationInventory({ page: 1, limit: 8 }), enabled: canManageCatalog, retry: false });

  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to use the developer dashboard.</StatusMessage></DashboardFrame>;

  const draftItems = drafts.data?.drafts ?? [];
  const submissionItems = submissions.data?.submissions ?? [];
  const catalogItems = catalog.data?.cartridges ?? [];
  const metrics = {
    drafts: draftItems.filter((item) => item.status === "draft").length,
    inReview: submissionItems.filter((item) => item.status !== "verified" && item.status !== "rejected").length,
    published: catalogItems.filter((item) => item.moderation_action !== "unpublished" && item.moderation_action !== "hidden").length,
    withdrawn: catalogItems.filter((item) => item.moderation_action === "unpublished").length,
  };
  const workflowError = drafts.error ?? submissions.error;
  const catalogError = catalog.error;

  return <DashboardFrame canSubmit={canSubmit}><div className="space-y-10">
    {!heroDismissed && <section className="relative overflow-hidden rounded-2xl bg-[#2a2041] p-6 text-white shadow-[0_18px_40px_rgb(46_32_86_/_0.16)] sm:p-8 lg:p-10"><div className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 opacity-50 lg:block" style={{ backgroundImage: "linear-gradient(rgb(255 255 255 / .08) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / .08) 1px, transparent 1px)", backgroundSize: "2rem 2rem", maskImage: "linear-gradient(90deg, transparent, black)" }} /><button type="button" onClick={dismissHero} aria-label="Dismiss dashboard banner" title="Dismiss dashboard banner" className="absolute right-4 top-4 z-10 grid size-8 place-items-center rounded-full text-violet-200 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#2a2041]"><X aria-hidden="true" className="size-4" /></button><div className="relative flex flex-col justify-between gap-8 lg:flex-row lg:items-center"><div className="max-w-2xl"><p className="technical-label text-violet-200">Developer console</p><h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Build, publish, repeat.</h1><p className="mt-4 max-w-xl text-sm leading-7 text-violet-100 sm:text-base">Manage your PRG32 cartridges from one place: keep drafts private, send releases to review, and control what stays visible in the public store.</p><div className="mt-7 flex flex-wrap gap-3"><Button asChild size="lg" className="bg-white text-[#2a2041] shadow-none hover:bg-violet-100"><Link href="/dashboard/publish"><CirclePlus aria-hidden="true" className="size-4" />Create a cartridge</Link></Button><Button asChild size="lg" variant="outline" className="border-white/40 text-white hover:border-white/70 hover:bg-white/10 hover:text-white"><Link href="/explore"><Store aria-hidden="true" className="size-4" />Open store</Link></Button></div></div><div className="relative hidden w-64 shrink-0 rounded-xl border border-white/15 bg-black/20 p-4 lg:block"><div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-200"><span>Pipeline</span><span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-300" />Live</span></div><div className="mt-5 space-y-3"><div className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-md bg-white/10"><FileCode2 className="size-3.5" /></span><div className="h-1.5 flex-1 rounded-full bg-white/15"><div className="h-full w-1/3 rounded-full bg-violet-300" /></div></div><div className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-md bg-white/10"><UploadCloud className="size-3.5" /></span><div className="h-1.5 flex-1 rounded-full bg-white/15"><div className="h-full w-2/3 rounded-full bg-violet-300" /></div></div><div className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-md bg-white/10"><PackageCheck className="size-3.5" /></span><div className="h-1.5 flex-1 rounded-full bg-white/15"><div className="h-full w-full rounded-full bg-emerald-300" /></div></div></div><p className="mt-5 text-xs text-violet-200">Draft → review → store</p></div></div></section>}

    <section aria-labelledby="dashboard-summary-heading">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div><p className="technical-label text-[var(--color-primary)]">At a glance</p><h2 id="dashboard-summary-heading" className="mt-1 text-xl font-bold tracking-tight">Your release health</h2></div>
        <p className="hidden text-sm text-[var(--color-text-muted)] sm:block">A live view of your Store activity.</p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricStat label="Published" value={metrics.published} detail="Visible in the store" icon={PackageCheck} tone="success" href="/dashboard/cartridges?status=published" />
        <MetricStat label="In review" value={metrics.inReview} detail="Waiting for an editor" icon={UploadCloud} tone="warning" href="/workspace?status=pending" />
        <MetricStat label="Drafts" value={metrics.drafts} detail="Private work in progress" icon={FileCode2} tone="primary" href="/dashboard/drafts" />
        <MetricStat label="Withdrawn" value={metrics.withdrawn} detail="Removed from public view" icon={Archive} href="/dashboard/cartridges?status=withdrawn" />
      </dl>
    </section>

    <section aria-labelledby="workspace-heading"><div className="flex flex-col justify-between gap-2 border-b border-[var(--color-border)] pb-4 sm:flex-row sm:items-end"><div><p className="technical-label text-[var(--color-primary)]">Workspace</p><h2 id="workspace-heading" className="mt-1 text-2xl font-bold tracking-tight">Choose your next move</h2></div><p className="text-sm text-[var(--color-text-muted)]">Three focused paths for your next release.</p></div><div className="mt-4 grid gap-4 md:grid-cols-3"><ActionCard href="/dashboard/publish" eyebrow="Start here" title="Create a cartridge" description="Upload a .prg32 bundle and send it through server validation." icon={CirclePlus} featured={canSubmit} /><ActionCard href="/dashboard/drafts" eyebrow="Keep building" title="Continue a draft" description="Return to private staging and attach the next bundle revision." icon={FolderKanban} /><ActionCard href="/dashboard/cartridges" eyebrow="Ship with confidence" title="Manage releases" description="Review store visibility and withdraw a release without deleting its data." icon={CheckCircle2} /></div></section>

    {workflowError && <StatusMessage tone="warning" className="p-4">{errorMessage(workflowError)}</StatusMessage>}{catalogError && <StatusMessage tone="warning" className="p-4">{errorMessage(catalogError)}</StatusMessage>}

    <section className="surface-card overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-5 sm:px-6">
        <div>
          <p className="technical-label text-[var(--color-primary)]">
            Release pipeline
          </p>
          <h2 className="mt-1 text-lg font-bold">Recent submissions</h2>
        </div>
        <Link
          href="/dashboard/cartridges"
          className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--color-primary-strong)] hover:underline"
        >
          View all
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
      {!canSubmit ? (
        <p className="py-6 text-sm text-[var(--color-text-muted)]">
          Your account does not have cartridge submission permission.
        </p>
      ) : submissions.isPending ? (
        <p className="py-6 text-sm text-[var(--color-text-muted)]">
          Loading your release pipeline…
        </p>
      ) : submissionItems.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">No releases yet</p>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Start with a cartridge bundle and your first release will appear here.
            </p>
          </div>
          <Button asChild size="sm">
            <Link href="/dashboard/publish">
              <Rocket aria-hidden="true" className="size-4" />
              Create first release
            </Link>
          </Button>
        </div>
      ) : (
        <ul className="bg-[var(--color-surface)]">
          {submissionItems
            .slice(0, 5)
            .map((submission) => (
              <SubmissionRow key={submission.id} submission={submission} />
            ))}
        </ul>
      )}
    </section>
  </div></DashboardFrame>;
}

export function DashboardDraftsWorkspace() {
  const hydrated = useHydrated();
  const current = useCurrentUser();
  const user = current.user;
  const canSubmit = Boolean(user?.permissions?.includes("catalog:submit"));
  const drafts = useQuery({ queryKey: workflowQueryKeys.drafts(), queryFn: listDrafts, enabled: canSubmit, retry: false });
  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view drafts.</StatusMessage></DashboardFrame>;
  const items = drafts.data?.drafts ?? [];
  return <DashboardFrame canSubmit={canSubmit}><div className="space-y-6"><PageHeader eyebrow="Private staging" title="Drafts" description="Keep unfinished cartridges private until the bundle and metadata are ready for review." action={<Button asChild><Link href="/dashboard/publish"><CirclePlus aria-hidden="true" className="size-4" />New cartridge</Link></Button>} />{drafts.error ? <StatusMessage tone="warning" className="p-4">{errorMessage(drafts.error)}</StatusMessage> : drafts.isPending ? <DashboardLoading /> : items.length === 0 ? <section className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center"><span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><FileCode2 aria-hidden="true" className="size-5" /></span><h2 className="mt-4 text-lg font-bold">Nothing in staging</h2><p className="mx-auto mt-2 max-w-md text-sm text-[var(--color-text-muted)]">Create a cartridge when you are ready to start a private release.</p><Button asChild className="mt-5"><Link href="/dashboard/publish">Create a draft</Link></Button></section> : <ul className="grid gap-3">{items.map((draft) => <DraftRow key={draft.id} draft={draft} />)}</ul>}</div></DashboardFrame>;
}

export function DashboardCartridgesWorkspace() {
  const hydrated = useHydrated();
  const searchParams = useSearchParams();
  const current = useCurrentUser();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 10;
  const status = searchParams.get("status");
  const catalogStatus = status === "published" || status === "withdrawn" || status === "hidden" ? status : undefined;
  const user = current.user;
  const canSubmit = Boolean(user?.permissions?.includes("catalog:submit"));
  const canManageCatalog = Boolean(user?.permissions?.includes("catalog:metadata:write"));
  const catalog = useQuery({ queryKey: adminQueryKeys.catalog({ moderation: true, page, limit, status: catalogStatus }), queryFn: () => adminApi.listModerationInventory({ page, limit, ...(catalogStatus === undefined ? {} : { status: catalogStatus }) }), enabled: canManageCatalog, retry: false, placeholderData: (previous) => previous });
  const moderation = useMutation({ mutationFn: ({ cartridge, action }: { cartridge: AdminCartridge; action: "unpublished" | "restored" }) => adminApi.moderateCartridge(cartridge.id, cartridge.selected_version, action, action === "unpublished" ? "Withdrawn from the developer dashboard" : "Restored from the developer dashboard"), onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminQueryKeys.catalogRoot() }) });
  function moderate(cartridge: AdminCartridge) {
    const withdrawn = cartridge.moderation_action === "unpublished";
    if (!withdrawn && !window.confirm(`Withdraw ${cartridge.title} from the public store?`)) return;
    moderation.mutate({ cartridge, action: withdrawn ? "restored" : "unpublished" });
  }
  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view cartridges.</StatusMessage></DashboardFrame>;
  const items = catalog.data?.cartridges ?? [];
  const total = catalog.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return <DashboardFrame canSubmit={canSubmit}><div className="space-y-6"><PageHeader eyebrow="Store control" title="My cartridges" description="See what is live, inspect the public detail page, and withdraw a release without deleting its cartridge data." action={<Button asChild><Link href="/dashboard/publish"><CirclePlus aria-hidden="true" className="size-4" />Publish new</Link></Button>} />{!canManageCatalog ? <StatusMessage tone="warning" className="p-4">Your account does not have permission to manage catalog visibility.</StatusMessage> : catalog.error ? <StatusMessage tone="warning" className="p-4">{errorMessage(catalog.error)}</StatusMessage> : catalog.isPending && !catalog.data ? <DashboardLoading /> : items.length === 0 ? <section className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center"><span className="mx-auto grid size-12 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"><Box aria-hidden="true" className="size-5" /></span><h2 className="mt-4 text-lg font-bold">No releases in the catalog</h2><p className="mx-auto mt-2 max-w-md text-sm text-[var(--color-text-muted)]">Publish a validated cartridge to see its store visibility here.</p><Button asChild className="mt-5"><Link href="/dashboard/publish">Publish a cartridge</Link></Button></section> : <section className="surface-card overflow-hidden"><div className="flex flex-col gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold">Catalog inventory</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">{total} {total === 1 ? "release" : "releases"} · page {page} of {totalPages}</p></div>{catalog.isFetching && <span className="text-xs text-[var(--color-primary-strong)]" role="status">Updating…</span>}</div><CatalogTable items={items} onModerate={moderate} pending={moderation.isPending} /><div className="flex flex-col gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-[var(--color-text-muted)]">Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}</p><nav aria-label="Catalog pagination" className="flex items-center gap-2"><Button type="button" size="sm" variant="secondary" disabled={page <= 1 || catalog.isFetching} onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}><ChevronLeft aria-hidden="true" className="size-4" />Previous</Button><span className="px-1 text-xs font-semibold text-[var(--color-text-muted)]">{page} / {totalPages}</span><Button type="button" size="sm" variant="secondary" disabled={page >= totalPages || catalog.isFetching} onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}>Next<ChevronRight aria-hidden="true" className="size-4" /></Button></nav></div></section>}</div></DashboardFrame>;
}

export function DashboardSubmissionDetailWorkspace({ submissionId }: { submissionId: number }) {
  const hydrated = useHydrated();
  const current = useCurrentUser();
  const user = current.user;
  const canSubmit = Boolean(user?.permissions?.includes("catalog:submit"));
  const validId = Number.isSafeInteger(submissionId) && submissionId > 0;
  const detail = useQuery({ queryKey: workflowQueryKeys.submission(validId ? submissionId : null), queryFn: () => getSubmission(submissionId), enabled: canSubmit && validId, retry: false });

  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view this submission.</StatusMessage></DashboardFrame>;
  if (!canSubmit) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Your account does not have permission to view submissions.</StatusMessage></DashboardFrame>;

  const submission = detail.data?.submission;
  const badge = submission ? submissionBadge(submission.status) : null;
  const architectures = submission?.architectures.map((architecture) => String(architecture.architecture ?? "Unknown target")) ?? [];

  return <DashboardFrame canSubmit={canSubmit}><div className="space-y-8"><PageHeader eyebrow="Release pipeline" title="Submission detail" description="Review the metadata, targets, and publication status for this release." action={<Button asChild variant="secondary"><Link href="/dashboard">Back to dashboard</Link></Button>} />{!validId ? <StatusMessage tone="warning" className="p-5">This submission ID is invalid.</StatusMessage> : detail.error ? <StatusMessage tone="warning" className="p-5">{errorMessage(detail.error)}</StatusMessage> : detail.isPending ? <DashboardLoading /> : !submission ? <StatusMessage tone="warning" className="p-5">This submission is no longer available.</StatusMessage> : <section className="surface-card overflow-hidden"><header className="flex flex-col gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6"><div><p className="technical-label text-[var(--color-primary)]">Submission #{submission.id}</p><h2 className="mt-2 text-2xl font-bold tracking-tight">{String(submission.metadata.title ?? submission.game_id)}</h2><p className="mt-1 text-sm text-[var(--color-text-muted)]">{submission.game_id} · version {submission.version}</p></div>{badge && <Badge variant={badge.variant}>{badge.label}</Badge>}</header><div className="space-y-7 p-5 sm:p-6"><dl className="grid gap-4 sm:grid-cols-3"><div className="border-l-2 border-[var(--color-primary)] pl-3"><dt className="technical-label text-[var(--color-text-muted)]">Submitted</dt><dd className="mt-1 text-sm font-semibold">{formatDate(submission.created_at)}</dd></div><div className="border-l-2 border-[var(--color-border)] pl-3"><dt className="technical-label text-[var(--color-text-muted)]">Reviewed</dt><dd className="mt-1 text-sm font-semibold">{formatDate(submission.reviewed_at)}</dd></div><div className="border-l-2 border-[var(--color-border)] pl-3"><dt className="technical-label text-[var(--color-text-muted)]">Submitted by</dt><dd className="mt-1 text-sm font-semibold">{submission.submitted_by}</dd></div></dl><div className="border-t border-[var(--color-border)] pt-6"><h3 className="font-semibold">Publication metadata</h3><dl className="mt-4 grid gap-4 sm:grid-cols-2">{["summary", "description", "license", "homepage", "repository", "tags"].map((key) => <div key={key} className="border-b border-[var(--color-border)] pb-3"><dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{key}</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{Array.isArray(submission.metadata[key]) ? submission.metadata[key].join(", ") : String(submission.metadata[key] ?? "—")}</dd></div>)}</dl></div><div className="border-t border-[var(--color-border)] pt-6"><h3 className="font-semibold">Target architectures</h3><div className="mt-3 flex flex-wrap gap-2">{architectures.map((architecture) => <Badge key={architecture} variant="architecture">{architecture}</Badge>)}</div></div>{submission.review_history && submission.review_history.length > 0 && <div className="border-t border-[var(--color-border)] pt-6"><h3 className="font-semibold">Review history</h3><ul className="mt-3 space-y-3">{submission.review_history.map((item, index) => <li key={`${String(item.decision_id)}-${index}`} className="border-l-2 border-[var(--color-border)] pl-3 text-sm"><p className="font-semibold">{String(item.decision ?? "Decision")}</p><p className="mt-1 text-xs text-[var(--color-text-muted)]">{String(item.reviewer_name ?? "Reviewer")} · {String(item.created_at ?? "")}</p>{item.note ? <p className="mt-2 whitespace-pre-wrap text-[var(--color-text-muted)]">{String(item.note)}</p> : null}</li>)}</ul></div>}</div></section>}</div></DashboardFrame>;
}

export function DashboardSettingsWorkspace({
  section,
}: {
  section: SettingsSectionId;
}) {
  const hydrated = useHydrated();
  const current = useCurrentUser();
  const user = current.user;
  const canSubmit = Boolean(user?.permissions?.includes("catalog:submit"));

  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view developer settings.</StatusMessage></DashboardFrame>;

  return <DashboardFrame canSubmit={canSubmit}><div className="space-y-8"><PageHeader eyebrow="Developer settings" title="Settings" description="Manage one focused area of the Cartridge Store configuration at a time." /><SettingsPanel section={section} /></div></DashboardFrame>;
}
