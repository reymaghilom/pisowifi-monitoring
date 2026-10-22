import { describe, expect, it } from "vitest";
import {
  AUTH_MESSAGES,
  MACHINE_LIMITS,
  MACHINE_MESSAGES,
  MONITORING_MESSAGES,
  adminPathSchema,
  apiError,
  apiErrorSchema,
  changePasswordSchema,
  cursorQuerySchema,
  fieldErrors,
  listResponseSchema,
  loginRequestSchema,
  PASSWORD_MAX_LENGTH,
  sessionUserResponseSchema,
  passwordResetConfirmSchema,
  sessionsResponseSchema,
  revokedSessionsResponseSchema,
  PASSWORD_RESET_TTL_MINUTES,
  machineInputSchema,
  machineMonitoringSchema,
  machineListQuerySchema,
  machineNameSchema,
  machineSchema,
  monitoringSettingsSchema,
  passwordResetRequestSchema,
  profileUpdateSchema,
  readyResponseSchema,
  roleSchema,
  seriesQuerySchema,
  ztIpSchema,
  ztNetworkIdSchema,
  remoteTicketResponseSchema,
} from "../src/index.js";

const errs = (r: { success: boolean; error?: unknown }) => (r.success ? {} : fieldErrors(r.error as never));

describe("machine field rules (approved UI messages)", () => {
  it.each([
    ["", MACHINE_MESSAGES.nameRequired],
    ["   ", MACHINE_MESSAGES.nameRequired],
  ])("name %j", (v, msg) => {
    expect(machineNameSchema.safeParse(v).error?.issues[0]?.message).toBe(msg);
  });

  it("IP: required, then IPv4 shape", () => {
    expect(ztIpSchema.safeParse(" ").error?.issues[0]?.message).toBe(MACHINE_MESSAGES.ipRequired);
    expect(ztIpSchema.safeParse("192.168.1").error?.issues[0]?.message).toBe(MACHINE_MESSAGES.ipInvalid);
    expect(ztIpSchema.safeParse("256.1.1.1").success).toBe(false);
    expect(ztIpSchema.parse(" 192.168.194.82 ")).toBe("192.168.194.82");
  });

  it("admin path must start with /", () => {
    expect(adminPathSchema.safeParse("admin").error?.issues[0]?.message).toBe(MACHINE_MESSAGES.pathInvalid);
    expect(adminPathSchema.safeParse("").error?.issues[0]?.message).toBe(MACHINE_MESSAGES.pathInvalid);
    expect(adminPathSchema.parse(" /admin ")).toBe("/admin");
  });

  it("network ID is optional, else 16 hex", () => {
    expect(ztNetworkIdSchema.parse("")).toBe("");
    expect(ztNetworkIdSchema.parse("8056C2E21C000001")).toBe("8056C2E21C000001");
    expect(ztNetworkIdSchema.safeParse("xyz").error?.issues[0]?.message).toBe(MACHINE_MESSAGES.ztNetworkIdInvalid);
  });
});

describe("machineInputSchema (API body)", () => {
  const base = { name: " PisoWiFi 03 ", ztIp: "192.168.194.90" };

  it("normalises and applies defaults", () => {
    expect(machineInputSchema.parse({ ...base, location: "  ", tags: [" Store", "store", "", "ANNEX"], ztNetworkId: "8056C2E21C000001" })).toEqual({
      name: "PisoWiFi 03",
      location: null,
      software: "WiFi5Soft",
      ztNetworkId: "8056c2e21c000001",
      ztIp: "192.168.194.90",
      adminPath: "/admin",
      tags: ["store", "annex"],
      monitoringEnabled: true,
    });
  });

  it("keeps ZeroTier Member ID optional (backend-only) and validates it when given", () => {
    expect(machineInputSchema.parse(base).ztMemberId).toBeUndefined();
    expect(machineInputSchema.parse({ ...base, ztMemberId: "A1B2C3D4E5" }).ztMemberId).toBe("a1b2c3d4e5");
    expect(errs(machineInputSchema.safeParse({ ...base, ztMemberId: "123" }))).toEqual({ ztMemberId: MACHINE_MESSAGES.ztMemberIdInvalid });
  });

  it("reports one message per field", () => {
    expect(errs(machineInputSchema.safeParse({ name: "", ztIp: "nope", adminPath: "x" }))).toEqual({
      name: MACHINE_MESSAGES.nameRequired,
      ztIp: MACHINE_MESSAGES.ipInvalid,
      adminPath: MACHINE_MESSAGES.pathInvalid,
    });
  });

  it("enforces API limits", () => {
    expect(machineInputSchema.safeParse({ ...base, name: "x".repeat(MACHINE_LIMITS.name + 1) }).success).toBe(false);
    expect(machineInputSchema.safeParse({ ...base, tags: Array.from({ length: 9 }, (_, i) => "t" + i) }).success).toBe(false);
  });

  it("accepts WiFi5Soft only (the default); other software is refused with a readable message", () => {
    expect(machineInputSchema.parse({ ...base, software: undefined }).software).toBe("WiFi5Soft");
    for (const software of ["Other", "Mikrotik"]) {
      expect(machineInputSchema.safeParse({ ...base, software }).error?.issues[0]?.message).toBe(MACHINE_MESSAGES.softwareUnsupported);
    }
  });

  it("monitoring toggle body is a boolean", () => {
    expect(machineMonitoringSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(machineMonitoringSchema.safeParse({ enabled: "no" }).success).toBe(false);
  });

  it("list query defaults and filters", () => {
    expect(machineListQuerySchema.parse({})).toEqual({ status: "all", sort: "name" });
    expect(machineListQuerySchema.safeParse({ status: "offline" }).success).toBe(false);
  });

  it("machine DTO keeps the four signals separate; internet is only ever unverified", () => {
    const dto = {
      id: "7f1b0c9e-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
      name: "PisoWiFi 01",
      location: null,
      description: null,
      software: "WiFi5Soft",
      softwareVersion: "v3.5.84",
      ztNetworkId: null,
      ztMemberId: null,
      ztIp: "192.168.194.82",
      adminPath: "/admin",
      tags: [],
      state: { http: "reachable", lastCheckAt: null, lastSuccessAt: null, zeroTier: "unknown", zeroTierLastSeenAt: null, internet: "unverified", monitor: "ok", monitoringEnabled: true },
      createdAt: "2026-10-11T06:00:00Z",
      updatedAt: "2026-10-11T06:00:00+08:00",
    };
    expect(machineSchema.parse(dto)).toEqual(dto);
    expect(machineSchema.safeParse({ ...dto, state: { ...dto.state, internet: "verified" } }).success).toBe(false);
  });
});

describe("monitoring settings", () => {
  it("uses the UI's messages for every invalid input", () => {
    for (const bad of ["0", "31", "2.5", "abc", ""]) {
      expect(errs(monitoringSettingsSchema.safeParse({ intervalSeconds: 60, timeoutSeconds: bad, staleThreshold: 3 }))).toEqual({
        timeoutSeconds: MONITORING_MESSAGES.timeout,
      });
    }
    expect(errs(monitoringSettingsSchema.safeParse({ intervalSeconds: 60, timeoutSeconds: 5, staleThreshold: "11" }))).toEqual({
      staleThreshold: MONITORING_MESSAGES.threshold,
    });
    expect(monitoringSettingsSchema.parse({ intervalSeconds: "300", timeoutSeconds: "5", staleThreshold: "3" })).toEqual({
      intervalSeconds: 300,
      timeoutSeconds: 5,
      staleThreshold: 3,
    });
    expect(monitoringSettingsSchema.safeParse({ intervalSeconds: 45, timeoutSeconds: 5, staleThreshold: 3 }).success).toBe(false);
  });

  it("series query: custom ranges need dates", () => {
    expect(seriesQuerySchema.parse({})).toEqual({ range: "14", metric: "uptime" });
    expect(seriesQuerySchema.safeParse({ range: "custom" }).success).toBe(false);
    expect(seriesQuerySchema.safeParse({ range: "custom", from: "2026-10-01", to: "2026-10-11" }).success).toBe(true);
  });
});

describe("auth contracts", () => {
  it("login: UI messages, trimmed email, remember defaults to true", () => {
    expect(errs(loginRequestSchema.safeParse({ email: " ", password: "" }))).toEqual({
      email: AUTH_MESSAGES.emailRequired,
      password: AUTH_MESSAGES.passwordRequired,
    });
    expect(loginRequestSchema.parse({ email: " a@b.co ", password: "x" })).toEqual({ email: "a@b.co", password: "x", remember: true });
    expect(loginRequestSchema.safeParse({ email: "a@b.co", password: "x".repeat(PASSWORD_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it("session response carries the user (no second-factor step)", () => {
    const user = { id: "6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60", email: "a@b.co", displayName: "A", role: "admin" };
    expect(sessionUserResponseSchema.parse({ user })).toEqual({ user });
    expect(sessionUserResponseSchema.safeParse({ twoFactorRequired: true }).success).toBe(false);
  });

  it("account contracts: session list, revoked count, reset confirm", () => {
    const item = { id: "6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60", label: "Chrome on Windows", current: true, createdAt: "2026-10-12T01:00:00Z", lastSeenAt: "2026-10-12T02:00:00+08:00" };
    expect(sessionsResponseSchema.parse({ items: [item] })).toEqual({ items: [item] });
    expect(revokedSessionsResponseSchema.safeParse({ revoked: -1 }).success).toBe(false);
    expect(passwordResetConfirmSchema.safeParse({ token: "t".repeat(43), password: "short" }).error?.issues[0]?.message).toBe(AUTH_MESSAGES.passwordTooShort);
    expect(PASSWORD_RESET_TTL_MINUTES).toBe(30);
  });

  it("roles are admin and viewer only", () => {
    expect(roleSchema.options).toEqual(["admin", "viewer"]);
    expect(roleSchema.safeParse("owner").success).toBe(false);
  });

  it("password change rules in the UI's order", () => {
    expect(errs(changePasswordSchema.safeParse({ currentPassword: "", newPassword: "short", confirmPassword: "x" }))).toEqual({
      currentPassword: AUTH_MESSAGES.currentPasswordRequired,
      newPassword: AUTH_MESSAGES.passwordTooShort,
      confirmPassword: AUTH_MESSAGES.passwordMismatch,
    });
    const same = "samepassword1";
    expect(errs(changePasswordSchema.safeParse({ currentPassword: same, newPassword: same, confirmPassword: same }))).toEqual({
      newPassword: AUTH_MESSAGES.passwordUnchanged,
    });
    expect(changePasswordSchema.safeParse({ currentPassword: "old", newPassword: "x".repeat(300), confirmPassword: "x".repeat(300) }).success).toBe(false);
  });

  it("profile and reset email", () => {
    expect(errs(profileUpdateSchema.safeParse({ displayName: " ", email: "bad" }))).toEqual({
      displayName: AUTH_MESSAGES.displayNameRequired,
      email: AUTH_MESSAGES.emailInvalid,
    });
    expect(passwordResetRequestSchema.parse({ email: " you@example.com " })).toEqual({ email: "you@example.com" });
  });
});

describe("API envelope", () => {
  it("error envelope", () => {
    const e = apiError("validation_failed", "Check the highlighted fields", { name: MACHINE_MESSAGES.nameTaken });
    expect(apiErrorSchema.parse(e)).toEqual(e);
    expect(apiError("not_found", "Route not found")).toEqual({ error: { code: "not_found", message: "Route not found" } });
  });

  it("pagination and list responses", () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(cursorQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    const list = listResponseSchema(machineNameSchema);
    expect(list.parse({ items: [" a "], nextCursor: null })).toEqual({ items: ["a"], nextCursor: null });
  });

  it("ready response matches the API's states", () => {
    for (const db of ["up", "down", "not_configured"]) expect(readyResponseSchema.safeParse({ status: "not_ready", db }).success).toBe(true);
  });
});

describe("remote gateway ticket", () => {
  const sig = "A".repeat(86);
  it("accepts only the gateway entry URL with a ticket fragment", () => {
    const ok = { entryUrl: `https://gw.example.com/__pisowifi/enter#t=eyJ2IjoxLCJhdWQiOiJ4In0.${sig}`, expiresAt: "2026-10-15T04:01:00.000Z" };
    expect(remoteTicketResponseSchema.safeParse(ok).success).toBe(true);
    for (const entryUrl of [
      `https://gw.example.com/admin#t=eyJ2IjoxLCJhdWQiOiJ4In0.${sig}`,
      `https://gw.example.com/__pisowifi/enter?t=eyJ2IjoxLCJhdWQiOiJ4In0.${sig}`,
      "https://gw.example.com/__pisowifi/enter#t=bad",
      `javascript:alert(1)//__pisowifi/enter#t=eyJ2IjoxLCJhdWQiOiJ4In0.${sig}`,
    ]) {
      expect(remoteTicketResponseSchema.safeParse({ ...ok, entryUrl }).success, entryUrl).toBe(false);
    }
  });
});
