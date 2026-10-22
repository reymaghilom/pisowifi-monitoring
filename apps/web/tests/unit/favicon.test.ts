/* App icons (Next.js App Router file conventions): the app's own brand mark, not the default Next.js icon. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const app = (f: string) => path.resolve(__dirname, "../../app", f);
const PNG = "89504e470d0a1a0a";

describe("app icons", () => {
  it("favicon.ico holds 16, 32 and 48 px PNG images", () => {
    const ico = fs.readFileSync(app("favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1); // icon
    const n = ico.readUInt16LE(4);
    const sizes = Array.from({ length: n }, (_, i) => ico.readUInt8(6 + 16 * i));
    expect(sizes).toEqual([16, 32, 48]);
    for (let i = 0; i < n; i++) {
      const off = ico.readUInt32LE(6 + 16 * i + 12);
      expect(ico.subarray(off, off + 8).toString("hex")).toBe(PNG);
    }
  });

  it("icon.svg is the brand mark: brand teal square with the app's Wi-Fi glyph", () => {
    const svg = fs.readFileSync(app("icon.svg"), "utf8");
    expect(svg).toContain('fill="#0f766e"');
    expect(svg).toContain('d="M2 9a14 14 0 0 1 20 0"');
  });

  it("apple-icon.png is a 180 x 180 PNG", () => {
    const png = fs.readFileSync(app("apple-icon.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe(PNG);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });
});
