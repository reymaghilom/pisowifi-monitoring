"use client";

/* Remote access setup progress, per browser (localStorage), because setup belongs to the device: a phone that
   finished setup says nothing about the PC. Only the user's own confirmations are stored, never anything detected. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Platform, SetupStepId } from "@/lib/domain/remote";

interface RemoteSetupState {
  /** null until the user (or the first visit's guess) picks one. */
  platform: Platform | null;
  done: Record<Platform, SetupStepId[]>;
  setPlatform: (p: Platform) => void;
  confirm: (p: Platform, step: SetupStepId) => void;
  /** Marks a step (and every later one) as not done, e.g. "authorization was removed". */
  undo: (p: Platform, steps: readonly SetupStepId[]) => void;
  reset: (p: Platform) => void;
}

const storage = createJSONStorage(() => {
  const noop = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  if (typeof window === "undefined") return noop;
  try {
    const ls = window.localStorage;
    return {
      getItem: (k: string) => {
        try {
          return ls.getItem(k);
        } catch {
          return null;
        }
      },
      setItem: (k: string, v: string) => {
        try {
          ls.setItem(k, v);
        } catch {}
      },
      removeItem: (k: string) => {
        try {
          ls.removeItem(k);
        } catch {}
      },
    };
  } catch {
    return noop;
  }
});

export const useRemoteSetup = create<RemoteSetupState>()(
  persist(
    (set) => ({
      platform: null,
      done: { windows: [], android: [] },
      setPlatform: (platform) => set({ platform }),
      confirm: (p, step) => set((s) => ({ done: { ...s.done, [p]: s.done[p].includes(step) ? s.done[p] : [...s.done[p], step] } })),
      undo: (p, steps) => set((s) => ({ done: { ...s.done, [p]: s.done[p].filter((x) => !steps.includes(x)) } })),
      reset: (p) => set((s) => ({ done: { ...s.done, [p]: [] } })),
    }),
    {
      name: "pw-remote-setup",
      storage,
      // Rehydrated after mount (StoreSync) so server and first client render match.
      skipHydration: true,
      partialize: (s) => ({ platform: s.platform, done: s.done }),
    },
  ),
);
