import { defineConfig, devices } from "@playwright/test";

/* API-mode end-to-end run: the real web app (production build in .next-e2e-api) → Next proxy → the real API on an
   in-memory PGlite database with seeded monitoring results (apps/api/tests/e2e/api-server.ts). Never touches
   Supabase, ZeroTier or a device. Run: npx playwright test -c playwright.api.config.ts */
const WEB = Number(process.env.E2E_WEB_PORT ?? 3310);
const API = Number(process.env.E2E_API_PORT ?? 4310);
const channel = process.env.PW_CHANNEL ?? "chrome";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "api-mode.spec.ts",
  outputDir: "./e2e/.artifacts/api-results",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    channel: channel === "chromium" ? undefined : channel,
  },
  webServer: [
    {
      command: "npx tsx tests/e2e/api-server.ts",
      cwd: "../api",
      url: `http://127.0.0.1:${API}/api/v1/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { E2E_API_PORT: String(API), E2E_WEB_ORIGIN: `http://localhost:${WEB}` },
    },
    {
      command: `npx next build && npx next start -p ${WEB}`,
      url: `http://localhost:${WEB}/login`,
      reuseExistingServer: false,
      timeout: 400_000,
      env: {
        NEXT_DIST_DIR: ".next-e2e-api",
        NEXT_PUBLIC_DATA_SOURCE: "api",
        NEXT_PUBLIC_DEMO_MODE: "false",
        NEXT_PUBLIC_REMOTE_MODE: "disabled",
        API_ORIGIN: `http://127.0.0.1:${API}`,
      },
    },
  ],
});
