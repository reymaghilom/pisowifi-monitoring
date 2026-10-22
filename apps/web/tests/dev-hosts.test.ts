import { describe, expect, it } from "vitest";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { parseDevAllowedHosts } from "@/lib/dev-hosts";

describe("DEV_ALLOWED_HOSTS", () => {
  it("unset or empty: no extra hosts", () => {
    expect(parseDevAllowedHosts(undefined)).toEqual([]);
    expect(parseDevAllowedHosts("")).toEqual([]);
    expect(parseDevAllowedHosts(" , ")).toEqual([]);
  });

  it("exact IPv4 addresses and host names, trimmed, lowercased, de-duplicated", () => {
    expect(parseDevAllowedHosts(" 192.168.100.226 , My-PC.lan,192.168.100.226")).toEqual(["192.168.100.226", "my-pc.lan"]);
  });

  it.each(["*", "*.lan", "192.168.100.*", "**", "http://192.168.100.226", "192.168.100.226:3000", "192.168.100.226/24", "256.1.1.1", "192.168.100", "-bad.lan", "a b"])(
    "rejects %s",
    (value) => {
      expect(() => parseDevAllowedHosts(value)).toThrow(/DEV_ALLOWED_HOSTS/);
    },
  );
});

describe("next.config allowedDevOrigins", () => {
  /** next.config reads DEV_ALLOWED_HOSTS when Next calls it with the phase. */
  const configFor = async (phase: string, hosts?: string) => {
    const { default: config } = await import("@/next.config");
    if (hosts === undefined) delete process.env.DEV_ALLOWED_HOSTS;
    else process.env.DEV_ALLOWED_HOSTS = hosts;
    try {
      return config(phase);
    } finally {
      delete process.env.DEV_ALLOWED_HOSTS;
    }
  };

  it("applies DEV_ALLOWED_HOSTS to the dev server only", async () => {
    expect((await configFor(PHASE_DEVELOPMENT_SERVER, "192.168.100.226")).allowedDevOrigins).toEqual(["192.168.100.226"]);
    for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER]) expect((await configFor(phase, "192.168.100.226")).allowedDevOrigins).toBeUndefined();
  });

  it("dev server without DEV_ALLOWED_HOSTS: localhost only (Next's default)", async () => {
    expect((await configFor(PHASE_DEVELOPMENT_SERVER)).allowedDevOrigins).toBeUndefined();
  });

  it("dev server with a wildcard: refuses to start", async () => {
    await expect(configFor(PHASE_DEVELOPMENT_SERVER, "*")).rejects.toThrow(/DEV_ALLOWED_HOSTS/);
  });
});
