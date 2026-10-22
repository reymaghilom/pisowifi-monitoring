import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

/** Same fixed clock for the app and the prototype, so both render identical sample data. */
export const FIXED_NOW = new Date(2026, 9, 11, 14, 0, 0);

export const PROTOTYPE_FILE = path.resolve(__dirname, "../../../design-reference/pisowifi-monitoring-design-system/reference/pisowifi-monitoring-prototype.html");

/** The prototype file has no <meta charset>; opened via file:// Chrome decodes it as Windows-1252
 *  ("…" becomes "â€¦"). Serve it from an intercepted http URL as UTF-8 instead. */
export const PROTOTYPE_URL = "http://prototype.local/pisowifi-monitoring-prototype.html";

export async function routePrototype(page: Page) {
  await page.route(PROTOTYPE_URL, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fs.readFileSync(PROTOTYPE_FILE) }),
  );
}

/** App route → prototype route key (prototype's window.__pw.go). Remote Administration is not compared: it
 *  intentionally departs from the prototype (direct ZeroTier client access replaced the planned VPS gateway). */
export const ROUTES: { path: string; proto: string; name: string }[] = [
  { path: "/dashboard", proto: "dash", name: "dashboard" },
  { path: "/machines", proto: "machines", name: "machines" },
  { path: "/machines/m1", proto: "detail", name: "machine-detail" },
  { path: "/history", proto: "history", name: "history" },
  { path: "/reports", proto: "reports", name: "reports" },
  { path: "/automations", proto: "auto", name: "automations" },
  { path: "/settings/profile", proto: "settings", name: "settings" },
];

export async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard");
}

/** Waits for client data (charts measure their width after hydration). */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
}
