import { Download, ExternalLink } from "lucide-react";
import Link from "next/link";

import type { Game } from "../../lib/api/contracts";
import {
  catalogDownloadPath,
  preferredCatalogArchitecture,
} from "../../lib/api/catalog";
import { Badge } from "../ui/badge";
import { CartridgeArtwork } from "./CartridgeArtwork";

function authorNames(game: Game): string {
  return game.authors
    .map((author) => typeof author === "string" ? author : author.name ?? "")
    .filter(Boolean)
    .join(", ");
}

export function CartridgeCard({ game }: { game: Game }) {
  const author = authorNames(game);
  const architecture = preferredCatalogArchitecture(game.architectures);
  const download = architecture && game.selected_version
    ? catalogDownloadPath(game.id, game.selected_version, architecture)
    : null;

  return (
    <article
      className="group flex min-w-0 flex-col overflow-hidden rounded-md border
        border-[var(--color-border)] bg-[var(--color-surface)] transition-colors
        hover:border-[var(--color-primary)]"
    >
      <Link
        aria-label={`Open ${game.title}`}
        href={`/games/${encodeURIComponent(game.id)}`}
        className="block focus-visible:outline-2 focus-visible:outline-offset-[-2px]
          focus-visible:outline-[var(--color-ring)]"
      >
        <CartridgeArtwork
          gameId={game.id}
          version={game.selected_version}
          kind="icon"
          alt=""
          className="aspect-[4/3] w-full border-b border-[var(--color-border)]
            transition-transform duration-300 group-hover:scale-[1.02]"
        />
        <div className="space-y-1.5 px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <h2
              className="min-w-0 truncate text-sm font-bold
                group-hover:text-[var(--color-primary-strong)]"
            >
              {game.title}
            </h2>
            {game.selected_version && <Badge variant="version">v{game.selected_version}</Badge>}
          </div>
          <p className="line-clamp-1 text-xs leading-5 text-[var(--color-text-muted)]">
            {game.summary || "No description published."}
          </p>
          {author && (
            <p className="truncate text-[11px] text-[var(--color-text-muted)]">
              By {author}
            </p>
          )}
        </div>
      </Link>
      <div
        className="mt-auto flex items-center justify-between gap-3 border-t
          border-[var(--color-border)] px-3.5 py-2.5"
      >
        <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="Available architectures">
          {game.architectures.map((item) => (
            <Badge key={item} variant="architecture">
              {item}
            </Badge>
          ))}
        </div>
        {download && (
          <a
            className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold
              text-[var(--color-primary-strong)] underline-offset-4 hover:underline
              focus-visible:outline-2 focus-visible:outline-[var(--color-ring)]"
            href={download}
          >
            <Download aria-hidden="true" className="size-3.5" />
            Download
          </a>
        )}
      </div>
      {game.tags.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-1 px-4 pb-3">
          {game.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="text-xs text-[var(--color-text-muted)]">
              #{tag}
            </span>
          ))}
        </div>
      )}
      <span className="sr-only">
        <ExternalLink aria-hidden="true" /> Open cartridge details
      </span>
    </article>
  );
}
