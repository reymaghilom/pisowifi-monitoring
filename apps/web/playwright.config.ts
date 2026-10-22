import { defineConfig, devices } from "@playwright/test";

/* End-to-end and visual tests run against a production build (`next start`).
   They use the locally installed Google Chrome (no browser download). Set PW_CHANNEL=chromium
   after `npx playwright install chromium` to use Playwright's bundled browser instead (e.g. in CI). */
const PORT = Number(process.env.PW_PORT ?? 3200);
const channel = process.env.PW_CHANNEL ?? "chrome";

export default defineConfig({
  testDir: "./e2e",
  // API mode has its own servers and config (playwright.api.config.ts).
  testIgnore: "api-mode.spec.ts",
  outputDir: "./e2e/.artifacts/test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "./e2e/.artifacts/report", open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    channel: channel === "chromium" ? undefined : channel,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    // Pin the mock data source: a developer's .env.local may select "api", which these flows don't run against.
    env: { NEXT_PUBLIC_DEMO_MODE: "true", NEXT_PUBLIC_DATA_SOURCE: "mock" },
  },
});
