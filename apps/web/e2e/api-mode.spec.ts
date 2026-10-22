/* API mode end to end: browser → Next → API → database (seeded PGlite harness, see playwright.api.config.ts).
   PISOWIFI 1 has three days of recorded checks with one 30-minute outage; PISOWIFI 2 has never been checked. */
import { expect, test, type Page } from "@playwright/test";

const USER = { email: "e2e-admin@example.test", password: "e2e correct horse battery" };
const CTL = `http://127.0.0.1:${Number(process.env.E2E_CTL_PORT ?? 4311)}`;

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Password", { exact: true }).fill(USER.password);
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** No horizontal page scroll (mobile and desktop). */
async function expectNoHorizontalScroll(page: Page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw + 1);
}

test.describe.configure({ mode: "serial" });

test("sign-in, dashboard statuses and the overview come from the API", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("Offline", { exact: false }).first()).toBeVisible();
  // Real counts: PISOWIFI 1 Online, PISOWIFI 2 has no check yet.
  await expect(page.getByText("1 without a check yet")).toBeVisible();
  await expect(page.getByText("Not checked yet").first()).toBeVisible();
  await expect(page.getByRole("img", { name: "Uptime per machine from recorded checks" })).toBeVisible();
  await expect(page.getByText("Recent status changes")).toBeVisible();
  await expect(page.getByText("Back online after 30 min offline").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Run check now/ })).toHaveCount(0);
  await expect(page.getByText(/sample|demo/i)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("monitoring history shows measured values and status changes", async ({ page }) => {
  await signIn(page);
  await page.goto("/history");
  await page.getByLabel("Date range").selectOption("24");
  await expect(page.getByText("97.9%")).toBeVisible();
  await expect(page.getByText("140 of 143 checks reached the machine")).toBeVisible();
  await expect(page.getByText("PISOWIFI 2 · no checks in this range")).toBeVisible();
  await expect(page.getByRole("img", { name: "PISOWIFI 1 status timeline" })).toBeVisible();
  await expect(page.getByText("2 status changes · page 1 of 1")).toBeVisible();
  await page.getByLabel("Status", { exact: true }).selectOption("unreachable");
  await expect(page.getByText("1 status change · page 1 of 1")).toBeVisible();
  await page.getByLabel("Machine", { exact: true }).selectOption({ label: "PISOWIFI 2" });
  await expect(page.getByText("No checks in this range")).toBeVisible();
  await expect(page.getByText(/coming soon|sample/i)).toHaveCount(0);
});

test("machine details list the latest checks with timestamps", async ({ page }) => {
  await signIn(page);
  await page.goto("/machines");
  await page.getByRole("button", { name: "View details for PISOWIFI 1" }).first().click();
  const table = page.getByRole("table", { name: "Most recent checks for PISOWIFI 1" });
  await expect(table).toBeVisible();
  await expect(table.getByText(/^HTTP 200 · \d+ ms$/).first()).toBeVisible();
  await expect(page).toHaveURL(/\/machines\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Uptime 24 h")).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Last checked" }).first()).toBeVisible();
});

test("new checks appear without reloading, and only valid checks change a status", async ({ page, request }) => {
  test.setTimeout(150_000);
  await signIn(page);
  await expect(page.getByText("1 without a check yet")).toBeVisible();
  // PISOWIFI 2 gets its first valid check; PISOWIFI 1 gets a failed one (Online -> Offline).
  expect((await (await request.post(`${CTL}/check`, { data: { machine: "PISOWIFI 2", ok: true } })).json()).to).toBe("reachable");
  expect((await (await request.post(`${CTL}/check`, { data: { machine: "PISOWIFI 1", ok: false } })).json()).to).toBe("unreachable");
  // The machine list refreshes every 30 s; no reload.
  await expect(page.getByText(/PISOWIFI 1\s+is offline\./).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("1 without a check yet")).toHaveCount(0);
  // History refreshes too and shows the new transition.
  await page.goto("/history");
  await page.getByLabel("Date range").selectOption("24");
  await expect(page.getByText("3 status changes · page 1 of 1")).toBeVisible({ timeout: 20_000 });
  await request.post(`${CTL}/check`, { data: { machine: "PISOWIFI 1", ok: true } });
});

test("phone layout: dashboard, history and details fit the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expectNoHorizontalScroll(page);
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "Status changes", exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto("/machines");
  await expect(page.getByRole("button", { name: "Refresh machine status" })).toBeVisible();
  await expect(page.getByRole("button", { name: /demo/i })).toHaveCount(0);
  await page.getByRole("button", { name: "PISOWIFI 1", exact: true }).click();
  await expect(page).toHaveURL(/\/machines\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("table", { name: "Most recent checks for PISOWIFI 1" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("an admin registers a new PisoWiFi; monitoring picks it up; pausing and deleting stop it", async ({ page, request }) => {
  test.setTimeout(180_000);
  const round = async (down: string[] = []) => (await (await request.post(`${CTL}/round`, { data: { down } })).json()) as { contacted: string[] };
  await signIn(page);
  await page.goto("/machines");
  await page.getByRole("button", { name: "Add machine" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Must be in 192.168.194.0/24 (the PisoWiFi ZeroTier network).")).toBeVisible();
  await dialog.getByLabel(/^Machine name/).fill("PISOWIFI 3");
  const ip = dialog.getByLabel(/^ZeroTier managed IP/);
  // SSRF attempts are refused by the API with a field error.
  for (const [bad, msg] of [
    ["169.254.169.254", "This address is reserved and can never be monitored"],
    ["10.0.0.5", "Use an address in the PisoWiFi ZeroTier network (192.168.194.0/24)"],
    ["192.168.194.22", "This address belongs to monitoring or admin equipment and can't be registered as a machine"],
  ]) {
    await ip.fill(bad);
    await dialog.getByRole("button", { name: "Save machine" }).click();
    await expect(dialog.getByText(msg)).toBeVisible();
  }
  await ip.fill("192.168.194.150");
  await dialog.getByRole("button", { name: "Save machine" }).click();
  await expect(page.getByRole("dialog").getByText("PISOWIFI 3 added")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  const row = page.getByRole("row", { name: /PISOWIFI 3/ });
  await expect(row.getByText("Not checked yet")).toBeVisible();

  // The next scheduled round (the worker's real code) includes it: no IP list, configuration or redeploy changed.
  expect((await round()).contacted).toContain("192.168.194.150");
  await expect(row.getByText("Online", { exact: true })).toBeVisible({ timeout: 45_000 });

  // Details and history support it.
  await page.getByRole("button", { name: "View details for PISOWIFI 3" }).first().click();
  await expect(page.getByRole("table", { name: "Most recent checks for PISOWIFI 3" }).getByText(/^HTTP 200 · \d+ ms$/)).toBeVisible();

  // Pausing stops the checks.
  await page.getByRole("button", { name: "Pause monitoring" }).click();
  await expect(page.getByRole("term").filter({ hasText: "Monitoring" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume monitoring" })).toBeVisible();
  expect((await round()).contacted).not.toContain("192.168.194.150");

  // Deleting removes it everywhere and from monitoring.
  await page.getByRole("button", { name: "Delete machine" }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete machine" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.goto("/machines");
  await expect(page.getByText("PISOWIFI 3")).toHaveCount(0);
  expect((await round()).contacted).not.toContain("192.168.194.150");
  await page.goto("/history");
  await expect(page.getByLabel("Machine", { exact: true }).locator("option", { hasText: "PISOWIFI 3" })).toHaveCount(0);
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/sessions").catch(() => {});
  const res = await page.request.post("/api/v1/auth/logout", { headers: { origin: new URL(page.url()).origin } });
  expect(res.ok()).toBe(true);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  expect((await page.request.get("/api/v1/auth/me")).status()).toBe(401);
});
