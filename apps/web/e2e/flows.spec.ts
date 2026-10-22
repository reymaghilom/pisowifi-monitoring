import { expect, test, type Page } from "@playwright/test";
import { FIXED_NOW, settle, signIn } from "./fixtures";

/* Functional parity with the approved prototype's interactions (mock data only).
   Cache Components keeps visited routes mounted but hidden (display:none), so label/text lookups use
   the visible-only helpers below; getByRole already ignores hidden content. */

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
});

const main = (page: Page) => page.locator("main");
/** Visible field by its exact label. */
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true }).filter({ visible: true });
/** Visible text (exact unless a RegExp is given). */
const text = (page: Page, t: string | RegExp) => page.getByText(t, { exact: typeof t === "string" }).filter({ visible: true });

test.describe("authentication", () => {
  test("wrong password, sign in, guard, sign out", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForURL("**/login");
    await field(page, "Password").fill("nope");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(text(page, /Invalid email or password/)).toBeVisible();
    await field(page, "Password").fill("demo");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/dashboard");
    await expect(text(page, "Signed in (demo)")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL("**/login");
    await page.goto("/machines");
    await page.waitForURL("**/login");
  });

  test("forgot password flow; no two-factor anywhere", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(text(page, "Enter a valid email address")).toBeVisible();
    await field(page, "Email").fill("you@example.com");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

    await signIn(page);
    await page.goto("/settings/security");
    await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
    await expect(page.getByText(/two-factor/i)).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Two-factor authentication" })).toHaveCount(0);
  });
});

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test("dashboard: three KPI cards (two statuses), overview chart, quick machines, range and legend", async ({ page }) => {
    for (const label of ["Total machines", "Online", "Offline"]) {
      await expect(main(page).locator(".pw-stat .pw-label", { hasText: new RegExp(`^${label}$`, "i") })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Machine Uptime" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Quick machines" })).toBeVisible();
    await expect(main(page).locator(".pw-stat")).toHaveCount(3);
    await expect(main(page).getByText(/Stale|Unknown|Monitoring Error|Need verification|Reachable|Unreachable/)).toHaveCount(0);
    // No prototype / demo / sample labels and no preview-state controls on the Dashboard.
    await expect(page.getByText(/Demo data|Sample data|Prototype|No live connection|Preview state/).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByLabel("Preview page state")).toHaveCount(0);
    await expect(main(page).locator(".pw-g-main .pw-card.flat")).toHaveCount(2);

    await page.getByRole("button", { name: "30 d" }).click();
    await expect(text(page, "Last 30 days")).toBeVisible();
    const legend = page.getByRole("button", { name: "PisoWiFi 02" }).first();
    await legend.click();
    await expect(legend).toHaveAttribute("aria-pressed", "false");

    const chart = page.locator(".cw svg").first();
    const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#tip")).toContainText("PisoWiFi 01:");

    await page.getByRole("button", { name: "Run check now (demo)" }).click();
    await expect(text(page, "Demo checks done. No requests were sent.")).toBeVisible();
  });

  test("my pisowifi: search, filter, sort, add, edit, delete", async ({ page }) => {
    await page.goto("/machines");
    await page.getByRole("textbox", { name: "Search machines" }).last().fill("127");
    await expect(main(page).locator("tbody tr")).toHaveCount(1);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await field(page, "Status").selectOption("unreachable");
    await expect(main(page).locator("tbody tr")).toHaveCount(1);
    await field(page, "Status").selectOption("all");
    await field(page, "Sort by").selectOption("ip");

    await main(page).getByRole("button", { name: "Add machine" }).click();
    await expect(field(page, "Machine name *")).toBeFocused();
    await expect(page.getByRole("dialog")).not.toContainText(/member id/i);
    await page.getByRole("button", { name: "Save machine" }).click();
    await expect(text(page, "Machine name is required")).toBeVisible();
    await field(page, "Machine name *").fill("PisoWiFi 01");
    await field(page, "ZeroTier managed IP *").fill("192.168.194.82");
    await field(page, "ZeroTier network ID").fill("xyz");
    await page.getByRole("button", { name: "Save machine" }).click();
    await expect(text(page, "Another machine already uses this name")).toBeVisible();
    await expect(text(page, "This IP is already registered")).toBeVisible();
    await expect(text(page, "Network ID is 16 hex characters")).toBeVisible();
    await field(page, "Machine name *").fill("PisoWiFi 03");
    await field(page, "ZeroTier managed IP *").fill("192.168.194.90");
    await field(page, "ZeroTier network ID").fill("8056c2e21c000001");
    await expect(page.getByLabel("Tags")).toHaveCount(0);
    await page.getByRole("button", { name: "Save machine" }).click();
    await expect(page.getByRole("heading", { name: "PisoWiFi 03 added" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(main(page).locator("tbody tr")).toHaveCount(3);

    await page.getByRole("button", { name: "Edit PisoWiFi 03" }).click();
    await field(page, "Location").fill("Annex");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "PisoWiFi 03 saved" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Delete PisoWiFi 03" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toBeHidden();
    await page.getByRole("button", { name: "Delete PisoWiFi 03" }).click();
    await page.getByRole("button", { name: "Delete machine" }).click();
    await expect(text(page, "PisoWiFi 03 deleted (demo)")).toBeVisible();
    await expect(main(page).locator("tbody tr")).toHaveCount(2);
  });

  test("machine details: one connectivity status, simulate state, monitoring failure keeps it, pause monitoring", async ({ page }) => {
    await page.goto("/machines/m1");
    await expect(main(page).locator(".pw-badge", { hasText: /^Online$/ }).first()).toBeVisible();
    await expect(main(page).getByText(/Stale|Recently Seen|Internet Not Yet Verified|Monitoring Error|Reachable|Unreachable/)).toHaveCount(0);
    await field(page, "Simulate state (demo)").selectOption("unreachable");
    await expect(text(page, "PisoWiFi 01 is offline.")).toBeVisible();
    await field(page, "Simulate state (demo)").selectOption("monitor");
    await expect(text(page, /keeps its last result/)).toBeVisible();
    await expect(text(page, "PisoWiFi 01 is offline.")).toBeVisible();
    await page.getByRole("button", { name: "Pause monitoring" }).click();
    await expect(page.getByRole("button", { name: "Resume monitoring" })).toBeVisible();
    await field(page, "Machine").selectOption("m2");
    await page.waitForURL("**/machines/m2");
    await expect(text(page, "PisoWiFi 02 is offline.")).toBeVisible();
  });

  test("remote administration: direct ZeroTier setup wizard, simulated open, failure and retry", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/remote?machine=m1");
    await expect(page.getByRole("tab", { name: "Windows PC", selected: true })).toBeVisible();
    await page.getByRole("button", { name: "ZeroTier One is installed" }).click();
    await page.getByRole("button", { name: /I've joined the network/ }).click();
    await expect(text(page, "Pending authorization")).toBeVisible();
    await page.getByRole("button", { name: /I’m authorized/ }).click();
    await page.getByRole("button", { name: "Open PisoWiFi 01 admin page" }).click();
    await expect(text(page, /Simulated: http:\/\/192\.168\.194\.82\/admin would open/)).toBeVisible();
    await page.getByRole("button", { name: "No, it didn’t load" }).click();
    await expect(page.getByRole("heading", { name: "Connection failed" })).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByRole("button", { name: "Yes, it loaded" }).click();
    await expect(page.getByRole("heading", { name: "Ready for Remote Access" })).toBeVisible();

    // Saved on this device: still ready after a reload.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ready for Remote Access" })).toBeVisible();
    await page.getByRole("tab", { name: "Android phone" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Review setup steps" }).click();
    await page.getByRole("tab", { name: "Android phone" }).click();
    await expect(page.getByRole("heading", { name: "Install ZeroTier One" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Turn on the network and allow the VPN" })).toBeVisible();

    expect(requests.filter((u) => u.includes("192.168.194."))).toEqual([]);
  });

  test("history: filters, custom range, paging and CSV", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/history");
    await expect(text(page, /events · page 1 of/)).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(text(page, /page 2 of/)).toBeVisible();
    await field(page, "Status").selectOption("unreachable");
    await expect(main(page).locator("tbody tr").first()).toContainText("Offline");
    await expect(main(page).locator("tbody")).not.toContainText(/Stale|Monitoring error|timed out|Reachable|Unreachable/);
    await field(page, "Date range").selectOption("custom");
    await expect(field(page, "From")).toBeVisible();
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(page.getByRole("button", { name: /csv/i })).toHaveCount(0);
  });

  test("reports: removed from navigation; the old URL redirects to the Dashboard", async ({ page }) => {
    await expect(page.getByRole("link", { name: "Reports & Analytics" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Notifications & Automations" })).toBeVisible();
    await page.goto("/reports");
    await page.waitForURL("**/dashboard");
    await expect(page.getByRole("heading", { name: "Machine Uptime" })).toBeVisible();
  });

  test("automations: tabs by keyboard, rule toggles", async ({ page }) => {
    await page.goto("/automations");
    await expect(page.getByRole("switch")).toHaveCount(2);
    await expect(main(page).getByText(/Daily report|Weekly report/)).toHaveCount(0);
    const recovery = page.getByRole("switch", { name: /Recovery notification/ });
    await recovery.click();
    await expect(recovery).toHaveAttribute("aria-checked", "false");
    await page.getByRole("tab", { name: "Rules" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Execution history" })).toHaveAttribute("aria-selected", "true");
    await expect(text(page, "Sample rows. No workflow has ever run.")).toBeVisible();
  });

  test("settings: every section, theme choice persists", async ({ page }) => {
    await page.goto("/settings/profile");
    // Each section is its own route. Wait for every navigation to finish before the next click:
    // otherwise Playwright can pick the button in the outgoing page, which Next.js then hides
    // (Activity, display:none) instead of detaching, and the click waits on it until the timeout.
    const sections: [string, string, string][] = [
      ["Security", "security", "Security"],
      ["Sessions", "sessions", "Sessions"],
      ["Theme", "theme", "Theme"],
      ["Monitoring", "monitoring", "Monitoring preferences"],
      ["ZeroTier", "zerotier", "ZeroTier"],
      ["Notifications", "notifications", "Notification preferences"],
      ["Automation", "automation", "Automation preferences"],
      ["Profile", "profile", "Profile"],
    ];
    for (const [button, slug, heading] of sections) {
      await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: button, exact: true }).click();
      await page.waitForURL("**/settings/" + slug);
      await expect(page.getByRole("heading", { name: heading, exact: true, level: 2 })).toBeVisible();
    }
    await field(page, "Display name").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(text(page, "Display name is required")).toBeVisible();

    await page.goto("/settings/theme");
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  });

  test("shell: collapse sidebar, global search, preview states, mobile drawer", async ({ page }) => {
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.locator(".pw-app")).toHaveClass(/collapsed/);
    await page.getByRole("button", { name: "Expand sidebar" }).click();

    await page.locator("#gsearch").fill("02");
    await page.waitForURL("**/machines");
    await expect(main(page).locator("tbody tr")).toHaveCount(1);

    // The demo "Preview state" select was removed from My PisoWiFi (and every page head).
    await expect(page.getByLabel("Preview page state")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const drawer = page.locator(".drawer-wrap");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(drawer.getByRole("link", { name: "Reports & Analytics" })).toHaveCount(0);
    await drawer.getByRole("link", { name: "Notifications & Automations" }).click();
    await page.waitForURL("**/automations");
    await expect(drawer).toBeHidden();
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
