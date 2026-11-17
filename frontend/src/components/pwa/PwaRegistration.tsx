"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/static/service-worker.js").catch(() => undefined);
  }, []);
  return null;
}
