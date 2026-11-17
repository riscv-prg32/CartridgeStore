import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  const storeOrigin =
    process.env.NEXT_PUBLIC_PRG32_STORE_ORIGIN?.trim() ||
    "https://store.prg32.test";

  return {
    nav: {
      title: "PRG32 Documentation",
      url: "/",
    },
    githubUrl: "https://github.com/riscv-prg32/PRG32",
    links: [
      { text: "Store", url: `${storeOrigin}/explore`, active: "none" },
      { text: "API reference", url: "/store/store-api" },
    ],
    searchToggle: {
      enabled: true,
    },
    themeSwitch: {
      enabled: true,
    },
  };
}
