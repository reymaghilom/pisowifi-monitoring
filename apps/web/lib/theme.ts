import type { ThemePref } from "@/lib/types";

export const THEME_KEY = "pw-theme";

/** Saved theme choice ("system" when none). Browser only. */
export function readSavedTheme(): ThemePref {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {}
  return "system";
}
