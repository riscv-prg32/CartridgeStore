import type { Metadata } from "next";
import type { ReactNode } from "react";

import { RootProvider } from "fumadocs-ui/provider/next";

import "./styles.css";

export const metadata: Metadata = {
  title: {
    default: "PRG32 Documentation",
    template: "%s · PRG32 Documentation",
  },
  description:
    "A source-driven guide to PRG32 cartridges, Store APIs, publishing, scores, metrics, and multiplayer.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
