"use client";

import { ArrowLeft, BarChart3, Check, ExternalLink, FileText, Minus, Package, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiRequestError } from "../../lib/api/client";
import { adminApi, AdminIntegrationUnavailableError } from "../../lib/api/admin";
import type { AdminCartridge } from "../../lib/api/admin/types";
import { adminQueryKeys } from "../../lib/api/query-keys";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { ColophonControls, TechnicalMetadata } from "../storefront/GameDetailPanels";
import { CartridgeArtwork } from "../storefront/CartridgeArtwork";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { StatusMessage } from "../ui/status";
import { DashboardFrame, DashboardLoading } from "./DashboardFrame";

function useHydrated(): boolean {
  return useSyncExternalStore(() => () => undefined, () => true, () => false);
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminIntegrationUnavailableError) return "The catalog management service is not available in this environment.";
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return "Sign in is required to view this cartridge.";
    if (error.status === 403) return "Your account does not have permission to view this cartridge.";
    if (error.status === 404) return "This cartridge could not be found in the catalog.";
  }
  return "Something went wrong while loading this cartridge.";
}

function formatDate(value: unknown): string {
  if (typeof value !== "string") return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readableNames(values: unknown[]): string[] {
  return values.flatMap((value) => {
    const record = recordValue(value);
    const name = stringValue(record?.name) ?? stringValue(record?.username) ?? stringValue(value);
    return name ? [name] : [];
  });
}

function developerName(colophon: Record<string, unknown> | null): string | null {
  return stringValue(recordValue(colophon?.developer)?.name);
}

function platformNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordValue(item);
    const name = stringValue(record?.label)
      ?? stringValue(record?.target)
      ?? stringValue(record?.platform)
      ?? stringValue(item);
    return name ? [name] : [];
  });
}

function publicationLabel(cartridge: AdminCartridge): { label: string; variant: "published" | "warning" | "danger" } {
  if (cartridge.moderation_action === "unpublished") return { label: "Withdrawn", variant: "danger" };
  if (cartridge.moderation_action === "hidden") return { label: "Hidden", variant: "warning" };
  return { label: "Published", variant: "published" };
}

function MediaStatus({ available }: { available: boolean }) {
  return available ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-success-foreground)]">
      <Check aria-hidden="true" className="size-3.5" />
      Included
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-muted)]">
      <Minus aria-hidden="true" className="size-3.5" />
      Not included
    </span>
  );
}

export function DashboardCartridgeDetailWorkspace({ cartridgeId }: { cartridgeId: string }) {
  const hydrated = useHydrated();
  const current = useCurrentUser();
  const searchParams = useSearchParams();
  const version = searchParams.get("version") ?? undefined;
  const user = current.user;
  const canManageCatalog = Boolean(user?.permissions?.includes("catalog:metadata:write"));
  const validId = cartridgeId.trim().length > 0;
  const query = useQuery({
    queryKey: adminQueryKeys.cartridge(validId ? cartridgeId : null, version),
    queryFn: () => adminApi.getModerationCartridge(cartridgeId, version),
    enabled: canManageCatalog && validId,
    retry: false,
  });

  if (!hydrated || current.isPending) return <DashboardFrame canSubmit={false}><DashboardLoading /></DashboardFrame>;
  if (current.error) return <DashboardFrame canSubmit={false}><StatusMessage tone="danger" className="p-5">{errorMessage(current.error)}</StatusMessage></DashboardFrame>;
  if (!user) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Sign in is required to view this cartridge.</StatusMessage></DashboardFrame>;
  if (!canManageCatalog) return <DashboardFrame canSubmit={false}><StatusMessage tone="warning" className="p-5">Your account does not have permission to view cartridges.</StatusMessage></DashboardFrame>;

  const cartridge = query.data?.cartridge;
  const status = cartridge ? publicationLabel(cartridge) : null;
  const metadata = cartridge?.metadata ?? null;
  const description = stringValue(metadata?.description);
  const colophon = cartridge?.colophon ?? null;
  const developer = developerName(colophon);
  const publisher = cartridge?.publisher || developer || readableNames(cartridge?.authors ?? [])[0] || "Not available";
  const assets = recordValue(metadata?.assets);
  const hasDeclaredIcon = Boolean(recordValue(assets?.icon));
  const hasDeclaredScreenshot = Boolean(recordValue(assets?.screenshot));
  const platforms = platformNames(metadata?.platforms);
  const tags = readableNames(cartridge?.tags ?? []);
  const hasColophonContent = Boolean(
    colophon &&
    (developer || stringValue(colophon.subtitle) || (Array.isArray(colophon.controls) && colophon.controls.length > 0)),
  );

  return (
    <DashboardFrame canSubmit>
      <div className="space-y-8">
        <header className="flex flex-col gap-5 border-b border-[var(--color-border)] pb-6">
          <Link href="/dashboard/cartridges" className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-[var(--color-primary-strong)] hover:underline">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back to my cartridges
          </Link>
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <p className="technical-label text-[var(--color-primary)]">Store control / Cartridge detail</p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight">{cartridge?.title ?? "Cartridge detail"}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
                Manage the published release metadata and inspect the bundle information without leaving the dashboard.
              </p>
            </div>
            {cartridge && (
              <div className="flex flex-wrap gap-3">
                <Button asChild variant="secondary">
                  <Link href={`/dashboard/cartridges/${encodeURIComponent(cartridge.id)}/statistics?version=${encodeURIComponent(cartridge.selected_version)}`}>
                    <BarChart3 aria-hidden="true" className="size-4" />
                    View statistics
                  </Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link href={"/games/" + encodeURIComponent(cartridge.id) + "?version=" + encodeURIComponent(cartridge.selected_version)}>
                    <ExternalLink aria-hidden="true" className="size-4" />
                    Open public store page
                  </Link>
                </Button>
              </div>
            )}
          </div>
        </header>

        {!validId ? (
          <StatusMessage tone="warning" className="p-5">This cartridge ID is invalid.</StatusMessage>
        ) : query.error ? (
          <StatusMessage tone="warning" className="p-5">{errorMessage(query.error)}</StatusMessage>
        ) : query.isPending ? (
          <DashboardLoading />
        ) : !cartridge ? (
          <StatusMessage tone="warning" className="p-5">This cartridge is no longer available.</StatusMessage>
        ) : (
          <div className="space-y-5">
            <section className="surface-card overflow-hidden">
              <div className="flex flex-col gap-5 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:flex-row sm:items-center sm:p-6">
                <CartridgeArtwork
                  gameId={cartridge.id}
                  version={cartridge.selected_version}
                  kind="icon"
                  alt={cartridge.title + " icon"}
                  className="size-24 shrink-0 rounded-xl border border-[var(--color-border)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-2xl font-bold tracking-tight">{cartridge.title}</h2>
                    <Badge variant={status?.variant}>{status?.label}</Badge>
                  </div>
                  <p className="mt-1 break-all text-sm text-[var(--color-text-muted)]">{cartridge.id}</p>
                  <p className="mt-3 text-sm text-[var(--color-text-muted)]">{cartridge.summary || "No summary published."}</p>
                </div>
              </div>
              <dl className="grid gap-4 p-5 sm:grid-cols-4 sm:p-6">
                <div><dt className="technical-label text-[var(--color-text-muted)]">Version</dt><dd className="mt-1 font-semibold">v{cartridge.selected_version}</dd></div>
                <div><dt className="technical-label text-[var(--color-text-muted)]">Publisher</dt><dd className="mt-1 font-semibold">{publisher}</dd></div>
                <div><dt className="technical-label text-[var(--color-text-muted)]">Updated</dt><dd className="mt-1 font-semibold">{formatDate(cartridge.updated_at)}</dd></div>
                <div><dt className="technical-label text-[var(--color-text-muted)]">Targets</dt><dd className="mt-1 font-semibold">{cartridge.architectures.join(" · ") || "None"}</dd></div>
              </dl>
            </section>

            {description && (
              <section className="surface-card p-5 sm:p-6">
                <div className="flex items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
                    <FileText aria-hidden="true" className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="technical-label text-[var(--color-primary)]">About this cartridge</p>
                    <h2 className="mt-1 font-bold">Description</h2>
                    <p className="mt-3 max-w-4xl text-base leading-7 text-[var(--color-text)]">{description}</p>
                  </div>
                </div>
              </section>
            )}

            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
              <TechnicalMetadata metadata={metadata} className="mt-0" />
              <section className="surface-card h-fit p-5 sm:p-6">
                <ColophonControls colophon={colophon} compact />
                {!hasColophonContent && (
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
                      <Package aria-hidden="true" className="size-4" />
                    </span>
                    <div>
                      <h2 className="font-bold">Colophon</h2>
                      <p className="mt-1 text-sm text-[var(--color-text-muted)]">No colophon was published with this cartridge.</p>
                    </div>
                  </div>
                )}
              </section>
            </div>

            <section className="surface-card p-5 sm:p-6">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
                  <ShieldCheck aria-hidden="true" className="size-4" />
                </span>
                <div>
                  <h2 className="font-bold">Published targets</h2>
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">Binary variants and media currently available for this cartridge.</p>
                </div>
              </div>
              {(platforms.length > 0 || tags.length > 0) && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {platforms.map((platform) => <Badge key={"platform-" + platform} variant="utility">{platform}</Badge>)}
                  {tags.map((tag) => <Badge key={"tag-" + tag} variant="utility">#{tag}</Badge>)}
                </div>
              )}
              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-sm">
                  <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                    <tr><th className="px-3 py-2 font-semibold">Architecture</th><th className="px-3 py-2 font-semibold">Size</th><th className="px-3 py-2 font-semibold">Icon asset</th><th className="px-3 py-2 font-semibold">Screenshot asset</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {Object.entries(cartridge.variants).map(([architecture, variant]) => (
                      <tr key={architecture}>
                        <th className="px-3 py-3 font-semibold">{architecture}</th>
                        <td className="px-3 py-3 text-[var(--color-text-muted)]">{variant.size} bytes</td>
                        <td className="px-3 py-3">{<MediaStatus available={Boolean(variant.icon_mime || hasDeclaredIcon)} />}</td>
                        <td className="px-3 py-3">{<MediaStatus available={Boolean(variant.has_screenshot || variant.screenshot_mime || hasDeclaredScreenshot)} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
    </DashboardFrame>
  );
}
