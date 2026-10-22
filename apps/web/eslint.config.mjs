import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Other NEXT_DIST_DIR builds: test harnesses (.next-e2e*) and deployment builds (.next-d3, .next-ra).
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Test output
    "e2e/.artifacts/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
