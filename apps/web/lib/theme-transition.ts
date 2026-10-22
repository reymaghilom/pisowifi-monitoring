import { flushSync } from "react-dom";
import type { ThemePref } from "@/lib/types";
import { useDemo } from "@/stores/demo-store";

const isDark = (t: ThemePref) => (t === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : t === "dark");

/** Switches the theme with a soft whole-page crossfade (View Transitions API; timing in pw.css).
 *  Without that API the colours fade instead; with reduced motion the switch is instant. */
export function switchTheme(next: ThemePref) {
  const root = document.documentElement;
  const apply = () => {
    // Set the attribute here (not only in StoreSync's effect) so the transition captures the new theme.
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    flushSync(() => useDemo.getState().setTheme(next));
  };

  const changes = isDark(next) !== isDark(useDemo.getState().theme);
  if (!changes || matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();

  if (!document.startViewTransition) {
    root.classList.add("theme-fade");
    apply();
    setTimeout(() => root.classList.remove("theme-fade"), 750);
    return;
  }

  root.classList.add("theme-vt");
  document.startViewTransition(apply).finished.finally(() => root.classList.remove("theme-vt"));
}
