"use client";

import { useEffect, useSyncExternalStore } from "react";
import { THEME_KEY, readSavedTheme } from "@/lib/theme";
import type { ThemePref } from "@/lib/types";
import { useDemo } from "@/stores/demo-store";
import { useRemoteSetup } from "@/stores/remote-setup-store";
import { useHydrated } from "@/hooks/use-hydrated";
import { DATA_SOURCE, getServices } from "@/lib/services";
import { verifySession } from "@/lib/session";

/** Restores the session's demo state, this device's remote access setup and saved theme after mount, then mirrors the theme
 *  to <html data-theme> ("system" removes it) and localStorage. */
export function StoreSync() {
  const theme = useDemo((s) => s.theme);
  const hydrated = useHydrated();

  useEffect(() => {
    // Rehydrate first: any store write before that would persist the defaults over the saved session.
    void Promise.resolve(useDemo.persist.rehydrate()).then(() => {
      if (DATA_SOURCE === "api") void verifySession(() => getServices().auth.currentUser());
    });
    void useRemoteSetup.persist.rehydrate();
    useDemo.getState().setTheme(readSavedTheme());
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const r = document.documentElement;
    if (theme === "system") r.removeAttribute("data-theme");
    else r.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme, hydrated]);

  return null;
}

function subscribeScheme(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** The theme actually showing: the stored choice, or the OS preference for "system". */
export function useEffectiveTheme(): "light" | "dark" {
  const theme: ThemePref = useDemo((s) => s.theme);
  const osDark = useSyncExternalStore(
    subscribeScheme,
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  return theme !== "system" ? theme : osDark ? "dark" : "light";
}
