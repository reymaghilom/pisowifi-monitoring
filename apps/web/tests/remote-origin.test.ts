import { describe, expect, it } from "vitest";
import { isConfiguredGatewayEntryUrl } from "@/lib/services/api/remote";

const ticket = "A".repeat(48) + "." + "B".repeat(86);
const origin = "https://gw.example.test";
const valid = `${origin}/__pisowifi/enter#t=${ticket}`;

describe("gateway entry destination", () => {
  it("accepts only the configured HTTPS origin and exact ticket entry format", () => {
    expect(isConfiguredGatewayEntryUrl(valid, origin)).toBe(true);
    for (const url of [
      `https://other.example.test/__pisowifi/enter#t=${ticket}`,
      `http://gw.example.test/__pisowifi/enter#t=${ticket}`,
      `https://gw.example.test.evil.test/__pisowifi/enter#t=${ticket}`,
      `https://gw.example.test@evil.test/__pisowifi/enter#t=${ticket}`,
      `https://gw.example.test/__pisowifi/enter?next=evil#t=${ticket}`,
      `javascript:alert(1)`,
      `https://gw.example.test/admin#t=${ticket}`,
    ]) expect(isConfiguredGatewayEntryUrl(url, origin)).toBe(false);
  });

  it("rejects absent or malformed configured origins", () => {
    for (const configured of [undefined, "", "http://gw.example.test", "https://gw.example.test/", "https://gw.example.test@evil.test"])
      expect(isConfiguredGatewayEntryUrl(valid, configured)).toBe(false);
  });
});
