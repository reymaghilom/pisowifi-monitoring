import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import type { GatewayChecker } from "../src/gateway/checker.js";
import { runScheduledRound } from "../src/gateway/schedule.js";

describe("scheduled checker ownership", () => {
  it("allows one overlapping worker round and skips the other", async () => {
    let held = false;
    const db = {
      orm: {
        transaction: async (fn: (tx: { execute: () => Promise<{ rows: { acquired: boolean }[] }> }) => Promise<boolean>) => {
          const acquired = !held;
          if (acquired) held = true;
          try { return await fn({ execute: async () => ({ rows: [{ acquired }] }) }); }
          finally { if (acquired) held = false; }
        },
      },
    } as unknown as Db;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checkAll = vi.fn(async () => { await gate; return []; });
    const checker = { checkAll } as unknown as GatewayChecker;
    const first = runScheduledRound(checker, db);
    await Promise.resolve();
    expect(await runScheduledRound(checker, db)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(checkAll).toHaveBeenCalledTimes(1);
    expect(checkAll).toHaveBeenCalledWith({ trigger: "schedule", skipPaused: true });
  });

  it("fails closed if ownership cannot be checked", async () => {
    const db = { orm: { transaction: async (fn: (tx: { execute: () => Promise<never> }) => Promise<unknown>) =>
      fn({ execute: async () => { throw new Error("database unavailable"); } }) } } as unknown as Db;
    const checkAll = vi.fn();
    await expect(runScheduledRound({ checkAll } as unknown as GatewayChecker, db)).rejects.toThrow("database unavailable");
    expect(checkAll).not.toHaveBeenCalled();
  });
});
