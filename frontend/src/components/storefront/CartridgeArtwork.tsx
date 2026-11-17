"use client";

import Image from "next/image";
import { useState } from "react";

import { cn } from "../../lib/cn";
import { catalogMediaPath } from "../../lib/api/catalog";

type CartridgeArtworkProps = {
  gameId: string;
  version: string;
  kind: "icon" | "screenshot";
  architecture?: string;
  alt: string;
  className?: string;
};

export function CartridgeArtwork({ gameId, version, kind, architecture, alt, className }: CartridgeArtworkProps) {
  const [failed, setFailed] = useState(false);
  const label = kind === "icon" ? "Artwork unavailable" : "Screenshot unavailable";

  if (failed) {
    return <div className={cn("flex items-center justify-center bg-[var(--color-surface-muted)] text-center text-xs text-[var(--color-text-muted)]", className)}>{label}</div>;
  }

  return (
    <div className={cn("relative overflow-hidden bg-[var(--color-surface-muted)]", className)}>
      <Image
        src={catalogMediaPath(gameId, kind, version, architecture)}
        alt={alt}
        fill
        unoptimized
        sizes={kind === "icon" ? "96px" : "(max-width: 768px) 100vw, 768px"}
        className="object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
