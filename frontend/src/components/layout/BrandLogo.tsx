"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import {
  MANAGED_ASSET_UPDATED_EVENT,
  managedAssetUrl,
} from "../../lib/runtime-assets";

const FALLBACK_LOGO = "/prg32_logo_transparent.png";

type ManagedAssetEvent = CustomEvent<{ kind?: "logo" | "favicon" }>;

/** Renders the canonical PRG32 Cartridge Store brand lockup. */
export function BrandLogo() {
  const [logoSrc, setLogoSrc] = useState(FALLBACK_LOGO);

  useEffect(() => {
    let disposed = false;
    const loadManagedLogo = async () => {
      const url = managedAssetUrl("logo");
      try {
        const response = await fetch(url, { cache: "no-store", credentials: "include" });
        if (!disposed && response.ok) setLogoSrc(url);
      } catch {
        // Keep the bundled logo when the API is unavailable or no custom logo exists.
      }
    };
    const onAssetUpdated = (event: Event) => {
      const { kind } = (event as ManagedAssetEvent).detail;
      if (kind === "logo") void loadManagedLogo();
    };

    void loadManagedLogo();
    window.addEventListener(MANAGED_ASSET_UPDATED_EVENT, onAssetUpdated);
    return () => {
      disposed = true;
      window.removeEventListener(MANAGED_ASSET_UPDATED_EVENT, onAssetUpdated);
    };
  }, []);

  return (
    <span className="isolate inline-flex min-w-0 items-center gap-3">
      <span className="relative z-0 flex h-12 w-[5.5rem] shrink-0 items-center justify-center overflow-hidden">
        <Image
          src={logoSrc}
          alt="PRG32"
          width={84}
          height={56}
          priority
          unoptimized
          onError={() => setLogoSrc(FALLBACK_LOGO)}
          className="block h-14 w-[5.25rem] max-w-none object-contain"
        />
      </span>
      <span
        className={[
          "relative z-10 min-w-0 whitespace-nowrap",
          "pl-1 text-[1.55rem] leading-none tracking-[-0.04em]",
        ].join(" ")}
      >
        <span className="font-extrabold text-[var(--color-text)]">PRG32</span>
        <span className="font-medium text-[var(--color-text-muted)]">
          {" Cartridge Store"}
        </span>
      </span>
    </span>
  );
}
