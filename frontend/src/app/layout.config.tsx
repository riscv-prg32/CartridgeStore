import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "PRG32 Documentation",
      url: "/docs",
    },
    githubUrl: "https://github.com/riscv-prg32/PRG32",
    links: [
      { text: "Store", url: "/explore", active: "none" },
      { text: "API reference", url: "/docs/store-api" },
    ],
    searchToggle: {
      enabled: true,
    },
    themeSwitch: {
      enabled: false,
    },
  };
}
