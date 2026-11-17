import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    globals: true,
    pool: "vmThreads",
    testTimeout: 15_000,
    exclude: ["e2e/**", "node_modules/**"],
  },
});
