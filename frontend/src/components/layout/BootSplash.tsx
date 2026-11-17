"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

const SPLASH_DURATION_MS = 760;
const SPLASH_EXIT_DURATION_MS = 240;

export function BootSplash() {
  // The root layout keeps this component mounted during client-side
  // navigation. It therefore runs on document loads and refreshes only.
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);

  const dismiss = useCallback(() => {
    setExiting(true);
    window.setTimeout(() => setVisible(false), SPLASH_EXIT_DURATION_MS);
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const showTimer = window.setTimeout(() => setVisible(true), 0);
    const timer = window.setTimeout(
      dismiss,
      reducedMotion ? 250 : SPLASH_DURATION_MS,
    );

    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(timer);
    };
  }, [dismiss]);

  if (!visible) return null;

  return (
    <div
      className={`boot-splash${exiting ? " boot-splash--exiting" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="Starting PRG32 Cartridge Store"
    >
      <div className="boot-splash__art">
        <Image
          src="/prg32-boot-splash.png"
          alt="PRG32 retro gaming and coding"
          fill
          priority
          sizes="(max-width: 640px) 78vw, 38rem"
          className="boot-splash__image"
        />
        <span className="boot-splash__bar-mask" aria-hidden="true" />
      </div>
    </div>
  );
}
