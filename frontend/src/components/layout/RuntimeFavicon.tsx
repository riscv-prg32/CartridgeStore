"use client";

import { useEffect } from "react";

import {
  MANAGED_ASSET_UPDATED_EVENT,
  managedAssetUrl,
  type ManagedAssetKind,
} from "../../lib/runtime-assets";

type ManagedAssetEvent = CustomEvent<{ kind?: ManagedAssetKind }>;

export function RuntimeFavicon() {
  useEffect(() => {
    let disposed = false;
    const fallback = "/static/icon-192.svg";
    const link =
      document.querySelector<HTMLLinkElement>("link[data-prg32-favicon]") ??
      document.querySelector<HTMLLinkElement>('link[rel~="icon"]') ??
      document.createElement("link");

    link.rel = "icon";
    link.dataset.prg32Favicon = "true";
    const onError = () => {
      link.href = fallback;
      link.type = "image/svg+xml";
    };
    link.addEventListener("error", onError);
    if (!link.parentElement) document.head.appendChild(link);
    link.href = fallback;
    link.type = "image/svg+xml";

    const loadManagedFavicon = async () => {
      const url = managedAssetUrl("favicon");
      try {
        const response = await fetch(url, { cache: "no-store", credentials: "include" });
        if (disposed || !response.ok) return;
        link.href = url;
        link.removeAttribute("type");
      } catch {
        // Keep the bundled favicon when the API is unavailable or no custom favicon exists.
      }
    };
    void loadManagedFavicon();

    const onAssetUpdated = (event: Event) => {
      const { kind } = (event as ManagedAssetEvent).detail;
      if (kind !== "favicon") return;
      void loadManagedFavicon();
    };
    window.addEventListener(MANAGED_ASSET_UPDATED_EVENT, onAssetUpdated);
    return () => {
      disposed = true;
      link.removeEventListener("error", onError);
      window.removeEventListener(MANAGED_ASSET_UPDATED_EVENT, onAssetUpdated);
    };
  }, []);

  return null;
}
