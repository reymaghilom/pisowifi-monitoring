/* Visual fidelity: the app vs the approved prototype, pixel by pixel.
   Both run on the same frozen clock so the sample data is identical. Toasts and the chart tooltip are hidden.
   Results: e2e/.artifacts/visual/report.md (+ app/proto/diff PNGs per screen). */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { FIXED_NOW, PROTOTYPE_URL, ROUTES, routePrototype, settle } from "./fixtures";

const OUT = path.resolve(__dirname, ".artifacts/visual");
const HIDE = "#toasts,#tip,nextjs-portal{display:none!important} *{caret-color:transparent!important}";

/** Max share of differing pixels (over the overlapping area) before a screen fails. */
const MAX_DIFF = 0.02;
/** Screens with a known, accepted difference (see the report notes). */
const KNOWN: Record<string, { max: number; why: string }> = {
  login: {
    max: 0.05,
    why: "Quirks mode gives the prototype's <form> a 14px bottom margin, so its banner sits 12px lower (computed: BackCompat, margin-bottom 14px).",
  },
  machines: { max: 0.08, why: "Table text: 14px per design tokens; the prototype file renders tables at 16px (quirks mode, no doctype)." },
  history: { max: 0.08, why: "Event-log table text: 14px per design tokens vs 16px in the quirks-mode prototype." },
  reports: { max: 0.05, why: "Reliability table text: 14px per design tokens vs 16px in the quirks-mode prototype." },
};

interface Row {
  screen: string;
  diff: number;
  appH: number;
  protoH: number;
  pass: boolean;
  note: string;
}
/* Rows are appended to a file as they are recorded: a failing test restarts the worker, which would
   otherwise lose earlier variants' results. The first variant starts a fresh file. */
const ROWS_FILE = path.join(OUT, "rows.jsonl");
const readRows = (): Row[] =>
  fs.existsSync(ROWS_FILE) ? fs.readFileSync(ROWS_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

type Variant = { width: number; theme: "light" | "dark" };
const VARIANTS: Variant[] = [
  { width: 1440, theme: "light" },
  { width: 1440, theme: "dark" },
  { width: 390, theme: "light" },
  { width: 390, theme: "dark" },
];

async function newPage(browser: Browser, v: Variant) {
  const ctx = await browser.newContext({ viewport: { width: v.width, height: 900 }, colorScheme: v.theme });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(FIXED_NOW);
  await routePrototype(page);
  return page;
}

async function shot(page: Page) {
  await page.addStyleTag({ content: HIDE });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  return PNG.sync.read(await page.screenshot({ fullPage: true, animations: "disabled" }));
}

function compare(name: string, app: PNG, proto: PNG) {
  const w = Math.min(app.width, proto.width);
  const h = Math.min(app.height, proto.height);
  const crop = (img: PNG) => {
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(img, out, 0, 0, w, h, 0, 0);
    return out;
  };
  const a = crop(app),
    p = crop(proto),
    d = new PNG({ width: w, height: h });
  const n = pixelmatch(a.data, p.data, d.data, w, h, { threshold: 0.1 });
  fs.writeFileSync(path.join(OUT, name + ".app.png"), PNG.sync.write(app));
  fs.writeFileSync(path.join(OUT, name + ".proto.png"), PNG.sync.write(proto));
  fs.writeFileSync(path.join(OUT, name + ".diff.png"), PNG.sync.write(d));
  return { diff: n / (w * h), appH: app.height, protoH: proto.height };
}

function record(name: string, base: string, r: { diff: number; appH: number; protoH: number }) {
  const known = KNOWN[base];
  const max = known?.max ?? MAX_DIFF;
  const row: Row = { screen: name, ...r, pass: r.diff <= max, note: known && r.diff > MAX_DIFF ? known.why : "" };
  fs.appendFileSync(ROWS_FILE, JSON.stringify(row) + "\n");
  writeReport();
  expect.soft(r.diff, `${name}: ${(r.diff * 100).toFixed(2)}% pixels differ (limit ${(max * 100).toFixed(0)}%)`).toBeLessThanOrEqual(max);
}

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

function writeReport() {
  const rows = readRows();
  const lines = [
    "# Visual fidelity report",
    "",
    `App vs approved prototype, frozen clock ${FIXED_NOW.toString()}. Diff = share of differing pixels over the overlapping area (pixelmatch threshold 0.1). Default limit ${MAX_DIFF * 100}%.`,
    "",
    "| Screen | Diff | App height | Prototype height | Result | Note |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...rows.map((r) => `| ${r.screen} | ${(r.diff * 100).toFixed(2)}% | ${r.appH} | ${r.protoH} | ${r.pass ? "pass" : "FAIL"} | ${r.note} |`),
  ];
  fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n") + "\n");
}

for (const v of VARIANTS) {
  const tag = `${v.width}-${v.theme}`;

  test(`screens match the prototype (${tag})`, async ({ browser }) => {
    if (v === VARIANTS[0] && fs.existsSync(ROWS_FILE)) fs.rmSync(ROWS_FILE);
    // prototype: sign in once, then switch routes in place
    const proto = await newPage(browser, v);
    await proto.goto(PROTOTYPE_URL);
    await proto.waitForTimeout(300);
    const protoLogin = await shot(proto);
    await proto.locator("button[type=submit]").click();
    await proto.waitForTimeout(1300);

    const app = await newPage(browser, v);
    await app.goto("/login");
    await settle(app);
    record(`login-${tag}`, "login", compare(`login-${tag}`, await shot(app), protoLogin));
    await app.reload();
    await app.getByRole("button", { name: "Sign in" }).click();
    await app.waitForURL("**/dashboard");

    for (const r of ROUTES) {
      await app.goto(r.path);
      await settle(app);
      await proto.evaluate((k) => (window as unknown as { __pw: { go: (k: string) => void } }).__pw.go(k), r.proto);
      await proto.waitForTimeout(500);
      const name = `${r.name}-${tag}`;
      record(name, r.name, compare(name, await shot(app), await shot(proto)));
    }

    // overlays: Add machine dialog (and the navigation drawer on mobile)
    await app.goto("/machines");
    await settle(app);
    await proto.evaluate(() => (window as unknown as { __pw: { go: (k: string) => void } }).__pw.go("machines"));
    await app.locator("main").getByRole("button", { name: "Add machine" }).click();
    await proto.locator("main [data-act=add]").first().click();
    await app.waitForTimeout(400);
    record(`add-dialog-${tag}`, "machines", compare(`add-dialog-${tag}`, await shot(app), await shot(proto)));
    await app.keyboard.press("Escape");
    await proto.keyboard.press("Escape");

    if (v.width < 900) {
      await app.getByRole("button", { name: "Open navigation menu" }).click();
      await proto.locator(".burger").click();
      await app.waitForTimeout(400);
      record(`drawer-${tag}`, "drawer", compare(`drawer-${tag}`, await shot(app), await shot(proto)));
    }
  });
}
