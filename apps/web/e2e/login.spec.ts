import { expect, test, type Page } from "@playwright/test";

/* Login page only: its features, then its layout across phone, tablet and desktop widths.
   Runs in demo mode (password "demo"); screenshots land in e2e/.artifacts/login/. */

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const signInButton = (page: Page) => page.getByRole("button", { name: "Sign in" });

test.describe("login page features", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("renders title, heading, fields and links", async ({ page }) => {
    await expect(page).toHaveTitle("Sign in · PisoWiFi Monitoring");
    await expect(page.getByRole("heading", { name: "Welcome back", level: 1 })).toBeVisible();
    await expect(field(page, "Email")).toHaveAttribute("type", "email");
    await expect(field(page, "Email")).toHaveAttribute("autocomplete", "username");
    await expect(field(page, "Password")).toHaveAttribute("type", "password");
    await expect(field(page, "Password")).toHaveAttribute("autocomplete", "current-password");
    await expect(page.getByRole("checkbox", { name: "Remember me" })).toBeChecked();
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot-password");
    await expect(signInButton(page)).toBeEnabled();
    await expect(page.getByText(/two-factor/i)).toHaveCount(0);
  });

  test("empty fields show inline validation", async ({ page }) => {
    await field(page, "Email").fill("");
    await field(page, "Password").fill("");
    await signInButton(page).click();
    await expect(page.getByText("Enter your email")).toBeVisible();
    await expect(page.getByText("Enter your password")).toBeVisible();
    await expect(field(page, "Email")).toHaveAttribute("aria-invalid", "true");
    await expect(field(page, "Password")).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/login$/);

    // Typing clears the field's error.
    await field(page, "Email").fill("operator@example.com");
    await expect(page.getByText("Enter your email")).toHaveCount(0);
  });

  test("whitespace-only email counts as empty", async ({ page }) => {
    // Login does not format-check emails (a malformed one fails like an unknown account), but trims them.
    await field(page, "Email").fill("   ");
    await signInButton(page).click();
    await expect(page.getByText("Enter your email")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("wrong password shows a banner that clears on edit", async ({ page }) => {
    await field(page, "Password").fill("wrong");
    await signInButton(page).click();
    await expect(page.getByText(/Invalid email or password/)).toBeVisible();
    await field(page, "Password").fill("wron");
    await expect(page.getByText(/Invalid email or password/)).toHaveCount(0);
  });

  test("show / hide password toggle", async ({ page }) => {
    const pw = field(page, "Password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(pw).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(pw).toHaveAttribute("type", "password");
  });

  test("remember me toggles", async ({ page }) => {
    const box = page.getByRole("checkbox", { name: "Remember me" });
    await box.click();
    await expect(box).not.toBeChecked();
    await box.click();
    await expect(box).toBeChecked();
  });

  test("forgot password link navigates", async ({ page }) => {
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await page.waitForURL("**/forgot-password");
  });

  test("keyboard: tab order and Enter submits", async ({ page }) => {
    await field(page, "Email").focus();
    await page.keyboard.press("Tab");
    await expect(field(page, "Password")).toBeFocused();
    await field(page, "Password").press("Enter");
    await page.waitForURL("**/dashboard");
  });

  test("valid sign-in reaches the dashboard", async ({ page }) => {
    await signInButton(page).click();
    await page.waitForURL("**/dashboard");
    await expect(page.getByText("Signed in (demo)")).toBeVisible();
  });
});

/* Layout breakpoint: the teal hero shows at ≥900px; below that only the form plus a mobile brand row. */
const VIEWPORTS = [
  { name: "phone-320", width: 320, height: 640 },
  { name: "phone-375", width: 375, height: 667 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "breakpoint-899", width: 899, height: 900 },
  { name: "breakpoint-900", width: 900, height: 900 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "desktop-1920", width: 1920, height: 1080 },
];

test.describe("login page responsiveness", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/login");
      await page.waitForLoadState("networkidle");

      // No horizontal scroll.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "page scrolls horizontally").toBeLessThanOrEqual(0);

      // Hero only on wide screens; mobile brand row only on narrow ones.
      const wide = vp.width >= 900;
      await expect(page.locator(".pw-auth-hero")).toBeVisible({ visible: wide });
      await expect(page.locator(".login-m")).toBeVisible({ visible: !wide });

      // Form card stays inside the viewport horizontally.
      const card = await page.locator(".pw-auth-card").boundingBox();
      expect(card).not.toBeNull();
      expect(card!.x).toBeGreaterThanOrEqual(0);
      expect(card!.x + card!.width).toBeLessThanOrEqual(vp.width);

      // Every control is visible, not clipped, and the main button is a comfortable tap target.
      for (const el of [field(page, "Email"), field(page, "Password"), page.getByRole("link", { name: "Forgot password?" }), signInButton(page)]) {
        await el.scrollIntoViewIfNeeded();
        await expect(el).toBeInViewport();
      }
      const btn = await signInButton(page).boundingBox();
      expect(btn!.height).toBeGreaterThanOrEqual(44);

      // Inputs are at least 16px so iOS Safari does not zoom in on focus.
      const fontSize = await field(page, "Email").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      if (!wide) expect.soft(fontSize, "email input font-size (iOS zooms below 16px)").toBeGreaterThanOrEqual(16);

      // Still works at this size.
      await field(page, "Password").fill("");
      await signInButton(page).click();
      await expect(page.getByText("Enter your password")).toBeVisible();

      await page.screenshot({ path: `e2e/.artifacts/login/${vp.name}.png`, fullPage: true });
    });
  }
});
