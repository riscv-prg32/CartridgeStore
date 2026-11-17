import { create } from "zustand";

export type Theme = "light" | "dark";

type ThemeState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  hydrateTheme: () => void;
};

function initialTheme(): Theme {
  // Keep the initial render identical on the server and client. The persisted
  // preference is applied by ThemeProvider after hydration.
  return "dark";
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    window.localStorage.setItem("prg32-theme", theme);
    set({ theme });
  },
  hydrateTheme: () => {
    const stored = window.localStorage.getItem("prg32-theme");
    if (stored === "light" || stored === "dark") set({ theme: stored });
  },
}));
