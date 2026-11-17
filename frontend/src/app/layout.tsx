import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "../components/layout/AppShell";
import { PwaRegistration } from "../components/pwa/PwaRegistration";
import { Providers } from "./providers";
import "../styles/index.css";

export const metadata: Metadata = {
  title: "PRG32 Cartridge Store",
  description: "Discover and download published PRG32 cartridges for hardware and QEMU.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: { url: "/favicon.ico" },
  },
};

const themeInitScript = `
  (() => {
    try {
      const storedTheme = window.localStorage.getItem("prg32-theme");
      if (storedTheme === "light" || storedTheme === "dark") {
        document.documentElement.dataset.theme = storedTheme;
        document.documentElement.classList.toggle("dark", storedTheme === "dark");
      }
    } catch {
      // localStorage may be unavailable; keep the server-rendered theme.
    }
  })();
`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script id="theme-init" dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <Providers>
          <PwaRegistration /><AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
