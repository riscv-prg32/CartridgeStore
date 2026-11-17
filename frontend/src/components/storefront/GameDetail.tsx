"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, Tag } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { ApiRequestError, ApiResponseValidationError } from "../../lib/api/client";
import {
  catalogDownloadPath,
  getGame,
  preferredCatalogArchitecture,
} from "../../lib/api/catalog";
import { catalogQueryKeys } from "../../lib/api/query-keys";
import type { Game } from "../../lib/api/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, MetadataRow } from "../ui/card";
import { SelectField, SelectItem } from "../ui/select";
import { CartridgeArtwork } from "./CartridgeArtwork";
import { CatalogError, DetailMissing } from "./CatalogState";
import { ColophonControls, TechnicalMetadata } from "./GameDetailPanels";

function authorNames(game: Game): string[] {
  return game.authors
    .map((author) => typeof author === "string" ? author : author.name ?? "")
    .filter(Boolean);
}

function formatSize(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(value / 1024)} KB`;
}

export function GameDetail() {
  const params = useParams<{ gameId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedVersion = searchParams.get("version") ?? undefined;
  const [architectureOverride, setArchitectureOverride] = useState<string | null>(null);
  const query = useQuery({
    queryKey: catalogQueryKeys.game(params.gameId, requestedVersion),
    queryFn: () => getGame(params.gameId, requestedVersion),
    staleTime: 30_000,
  });
  const game = query.data?.game;
  const architecture = architectureOverride && game?.architectures.includes(architectureOverride)
    ? architectureOverride
    : game
      ? preferredCatalogArchitecture(game.architectures)
      : undefined;
  const variant = architecture && game ? game.variants[architecture] : undefined;
  const downloadUrl = game && architecture
    ? catalogDownloadPath(game.id, game.selected_version, architecture)
    : undefined;
  const authors = game ? authorNames(game) : [];
  const hasScreenshot = Boolean(
    game && architecture && game.variants[architecture]?.has_screenshot === true,
  );

  if (query.isPending) {
    return (
      <main className="page-gutter py-14">
        <div
          className="h-96 animate-pulse rounded-xl bg-[var(--color-surface-muted)]"
          aria-busy="true"
          aria-label="Loading cartridge details"
        />
      </main>
    );
  }

  if (query.isError) {
    if (query.error instanceof ApiRequestError && query.error.status === 404) {
      return (
        <main className="page-gutter py-14">
          <DetailMissing />
        </main>
      );
    }
    if (query.error instanceof ApiResponseValidationError) {
      return (
        <main className="page-gutter py-14">
          <CatalogError onRetry={() => void query.refetch()} />
        </main>
      );
    }
    return (
      <main className="page-gutter py-14">
        <CatalogError onRetry={() => void query.refetch()} />
      </main>
    );
  }

  if (!game) {
    return (
      <main className="page-gutter py-14">
        <DetailMissing />
      </main>
    );
  }

  const currentGame = game;

  function chooseVersion(version: string) {
    router.push(
      `/games/${encodeURIComponent(currentGame.id)}?${new URLSearchParams({ version })}`,
    );
    setArchitectureOverride(null);
  }

  return (
    <main className="page-gutter py-7 sm:py-9">
      <Link
        href="/explore"
        className="inline-flex items-center gap-2 text-sm font-semibold
          text-[var(--color-primary-strong)] hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to Explore
      </Link>
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
        <div className="min-w-0 space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="technical-label text-[var(--color-primary)]">
                Cartridge detail
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                  {game.title}
                </h1>
                <Badge variant="published">Published</Badge>
              </div>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                {game.summary || "No description published."}
              </p>
            </div>
            <Badge variant="version">v{game.selected_version}</Badge>
          </header>
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            {hasScreenshot && architecture ? (
              <CartridgeArtwork
                key={`${game.id}-${game.selected_version}-${architecture}`}
                gameId={game.id}
                version={game.selected_version}
                kind="screenshot"
                architecture={architecture}
                alt={`${game.title} screenshot`}
                className="aspect-video w-full"
              />
            ) : (
              <div
                className="flex aspect-video items-center justify-center
                  bg-[var(--color-surface-muted)] p-8 sm:p-12"
              >
                <CartridgeArtwork
                  gameId={game.id}
                  version={game.selected_version}
                  kind="icon"
                  alt={`${game.title} artwork`}
                  className="size-48 rounded-xl border border-[var(--color-border)]
                    shadow-[var(--shadow-card)] sm:size-56"
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-4 py-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Available targets
              </span>
              {game.architectures.map((item) => (
                <Badge
                  key={item}
                  variant={item === architecture ? "game" : "architecture"}
                >
                  {item}
                </Badge>
              ))}
            </div>
          </div>
          <Card>
            <CardHeader>
              <h2 className="font-bold">About this cartridge</h2>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                {game.summary || "No additional description was published for this cartridge."}
              </p>
              {game.tags.length > 0 && (
                <div className="mt-5 flex flex-wrap gap-2" aria-label="Cartridge tags">
                  {game.tags.map((tag) => (
                    <Badge key={tag} variant="utility">
                      <Tag aria-hidden="true" className="mr-1 size-3" />
                      #{tag}
                    </Badge>
                  ))}
                </div>
              )}
              <ColophonControls colophon={game.colophon} />
            </CardContent>
          </Card>
        </div>
        <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader>
              <h2 className="font-bold">Download cartridge</h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Select the exact published binary for your target.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <SelectField
                label="Version"
                name="detail-version"
                value={game.selected_version}
                onValueChange={chooseVersion}
              >
                <SelectItem value={game.selected_version}>
                  {game.selected_version}
                </SelectItem>
                {game.versions
                  .filter((version) => version !== game.selected_version)
                  .map((version) => (
                    <SelectItem key={version} value={version}>
                      {version}
                    </SelectItem>
                  ))}
              </SelectField>
              <SelectField
                label="Architecture"
                name="detail-architecture"
                value={architecture ?? "__none__"}
                onValueChange={(value) =>
                  setArchitectureOverride(value === "__none__" ? null : value)
                }
                disabled={game.architectures.length === 0}
              >
                <SelectItem value="__none__" disabled>
                  No architecture
                </SelectItem>
                {game.architectures.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectField>
              {downloadUrl ? (
                <Button asChild className="w-full">
                  <a href={downloadUrl}>
                    <Download aria-hidden="true" className="size-4" />
                    Download {architecture}
                  </a>
                </Button>
              ) : (
                <p className="text-sm text-[var(--color-text-muted)]" role="status">
                  No downloadable architecture is available for this version.
                </p>
              )}
              <p className="text-xs leading-5 text-[var(--color-text-muted)]">
                The existing Store API serves the binary and retains its download accounting.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <h2 className="font-bold">Published information</h2>
            </CardHeader>
            <CardContent>
              <dl>
                <MetadataRow
                  label="Author"
                  value={authors.join(", ") || "Not specified"}
                />
                {game.publisher && (
                  <MetadataRow label="Publisher" value={game.publisher} />
                )}
                <MetadataRow label="Version" value={game.selected_version} />
                {formatSize(variant?.size) && (
                  <MetadataRow
                    label="File size"
                    value={formatSize(variant?.size) ?? ""}
                  />
                )}
              </dl>
            </CardContent>
          </Card>
        </aside>
      </div>
      <TechnicalMetadata metadata={game.metadata} />
    </main>
  );
}
