import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/docs",
  output: "standalone",
  reactStrictMode: true,
  allowedDevOrigins: [
    process.env.PRG32_STORE_DOMAIN?.trim() || "store.prg32.test",
  ],
  async redirects() {
    return [
      "getting-started",
      "cartridge-format",
      "metadata",
      "publishing",
      "multiplayer",
      "scores",
      "metrics",
      "store-api",
    ].map((slug) => ({
      source: `/${slug}`,
      destination: `/store/${slug}`,
      permanent: true,
    }));
  },
};

export default createMDX()(nextConfig);
