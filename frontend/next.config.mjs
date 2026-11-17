import { createMDX } from "fumadocs-mdx/next";

const configuredApiOrigin = process.env.NEXT_PUBLIC_PRG32_API_ORIGIN?.trim();
const configuredStoreOrigin = process.env.NEXT_PUBLIC_PRG32_STORE_ORIGIN?.trim();
const configuredDistDir = process.env.PRG32_NEXT_DIST_DIR?.trim();
const isProductionBuild = process.env.NODE_ENV === "production";

if (configuredApiOrigin) {
  let parsedApiOrigin;
  try {
    parsedApiOrigin = new URL(configuredApiOrigin);
  } catch {
    throw new Error("NEXT_PUBLIC_PRG32_API_ORIGIN must be a valid origin");
  }
  if (
    parsedApiOrigin.username ||
    parsedApiOrigin.password ||
    parsedApiOrigin.pathname !== "/" ||
    parsedApiOrigin.search ||
    parsedApiOrigin.hash ||
    (isProductionBuild && parsedApiOrigin.protocol !== "https:")
  ) {
    throw new Error(
      "NEXT_PUBLIC_PRG32_API_ORIGIN must be an origin without credentials or a path.",
    );
  }
}

if (
  configuredDistDir &&
  (!/^\.next-[A-Za-z0-9._-]+$/u.test(configuredDistDir) ||
    configuredDistDir.includes(".."))
) {
  throw new Error(
    "PRG32_NEXT_DIST_DIR must be an isolated .next-* directory name.",
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: [
    process.env.PRG32_STORE_DOMAIN?.trim() || "store.prg32.test",
  ],
  env: {
    NEXT_PUBLIC_AUTH_INTEGRATION_ENABLED: "true",
    NEXT_PUBLIC_PRG32_UI93_AUTHENTICATED:
      process.env.PRG32_UI93_AUTHENTICATED === "1" ? "true" : "false",
    ...(configuredApiOrigin
      ? { NEXT_PUBLIC_PRG32_API_ORIGIN: configuredApiOrigin }
      : {}),
    ...(configuredStoreOrigin
      ? { NEXT_PUBLIC_PRG32_STORE_ORIGIN: configuredStoreOrigin }
      : {}),
  },
  output: "standalone",
  ...(configuredDistDir ? { distDir: configuredDistDir } : {}),
};

export default createMDX()(nextConfig);
