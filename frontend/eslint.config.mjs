import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  globalIgnores([
    ".next/**",
    ".next-*/**",
    ".next-ui92/**",
    ".next-ui93/**",
    "out/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);
