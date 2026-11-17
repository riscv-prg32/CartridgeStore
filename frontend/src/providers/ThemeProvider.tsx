"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";

import { useThemeStore } from "../stores/theme-store";

export function ThemeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const theme = useThemeStore((state) => state.theme);
  const hydrateTheme = useThemeStore((state) => state.hydrateTheme);

  useEffect(() => {
    hydrateTheme();
  }, [hydrateTheme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return children;
}
