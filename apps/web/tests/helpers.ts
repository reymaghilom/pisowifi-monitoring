import { vi } from "vitest";
import { resetHistoryForTesting } from "@/lib/mock/history";

/** A fixed "now" (Sat 11 Oct 2026, 14:00 local) so sample history and relative times are deterministic. */
export const FIXED_NOW = new Date(2026, 9, 11, 14, 0, 0).getTime();

/** Freeze Date.now() (timers stay real unless `fakeTimers`) and regenerate the sample history. */
export function freezeTime(now = FIXED_NOW, fakeTimers = false) {
  if (fakeTimers) vi.useFakeTimers({ now });
  else vi.useFakeTimers({ now, toFake: ["Date"] });
  resetHistoryForTesting();
}
