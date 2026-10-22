import { describe, expect, it } from "vitest";
import {
  IP4,
  hasErrors,
  strength,
  validateLogin,
  validateMachine,
  validateMonitoring,
  validatePasswordChange,
  validateProfile,
  validateResetEmail,
} from "@/lib/validation";
import { makeMachine } from "@/stores/demo-store";
import type { MachineInput } from "@/lib/types";

const existing = [makeMachine({ id: "m1", name: "PisoWiFi 01", ip: "192.168.194.82" })];
const input = (o: Partial<MachineInput> = {}): MachineInput => ({
  name: "PisoWiFi 03",
  loc: "",
  desc: "",
  sw: "WiFi5Soft",
  ver: "",
  ztNet: "",
  ip: "192.168.194.90",
  path: "/admin",
  tags: [],
  ...o,
});

describe("validateMachine", () => {
  it("accepts a valid machine", () => {
    expect(validateMachine(input(), existing, null)).toEqual({});
  });

  it("requires name, IP and a path starting with /", () => {
    expect(validateMachine(input({ name: " ", ip: "", path: "admin" }), existing, null)).toEqual({
      name: "Machine name is required",
      ip: "ZeroTier managed IP is required",
      path: "Admin path must start with /",
    });
  });

  it("rejects duplicate names (case-insensitive) and IPs, except for the machine being edited", () => {
    const dup = input({ name: "pisowifi 01", ip: "192.168.194.82" });
    expect(validateMachine(dup, existing, null)).toEqual({
      name: "Another machine already uses this name",
      ip: "This IP is already registered",
    });
    expect(validateMachine(dup, existing, "m1")).toEqual({});
  });

  it("checks IPv4 shape", () => {
    expect(validateMachine(input({ ip: "192.168.1" }), existing, null).ip).toBe("Enter a full IPv4 address, e.g. 192.168.194.82");
    expect(IP4.test("256.1.1.1")).toBe(false);
    expect(IP4.test("10.0.0.255")).toBe(true);
  });

  it("only validates the optional network ID when given (16 hex characters)", () => {
    expect(validateMachine(input({ ztNet: "" }), existing, null)).toEqual({});
    expect(validateMachine(input({ ztNet: "8056c2e21c000001" }), existing, null)).toEqual({});
    expect(validateMachine(input({ ztNet: "xyz" }), existing, null).ztNet).toBe("Network ID is 16 hex characters");
  });

  it("has no ZeroTier Member ID rule", () => {
    expect(Object.keys(input())).not.toContain("ztMember");
  });
});

describe("other forms", () => {
  it("login requires both fields", () => {
    expect(validateLogin("", "")).toEqual({ email: "Enter your email", pw: "Enter your password" });
    expect(hasErrors(validateLogin("a@b.co", "x"))).toBe(false);
  });

  it("reset email must look like an email", () => {
    expect(validateResetEmail("nope")).toBe("Enter a valid email address");
    expect(validateResetEmail("you@example.com")).toBeUndefined();
  });

  it("profile", () => {
    expect(validateProfile("", "bad")).toEqual({ name: "Display name is required", email: "Enter a valid email address" });
  });

  it("password change", () => {
    expect(validatePasswordChange("", "short", "x")).toEqual({
      cur: "Enter your current password",
      nw: "Use at least 12 characters",
      cf: "Passwords do not match",
    });
    expect(validatePasswordChange("samepassword1", "samepassword1", "samepassword1").nw).toBe("Choose a different password");
    expect(hasErrors(validatePasswordChange("old", "a-much-longer-pass", "a-much-longer-pass"))).toBe(false);
  });

  it("monitoring preferences use whole-number ranges", () => {
    expect(validateMonitoring("0", "11")).toEqual({ timeout: "Enter a whole number from 1 to 30", thr: "Enter a whole number from 1 to 10" });
    expect(validateMonitoring("2.5", "3").timeout).toBeDefined();
    expect(validateMonitoring("5", "3")).toEqual({});
  });

  it("password strength scores 0–5", () => {
    expect(strength("")).toBe(0);
    expect(strength("abcdefghijkl")).toBe(1);
    expect(strength("Abcdefghijklmnop1!")).toBe(5);
  });
});
