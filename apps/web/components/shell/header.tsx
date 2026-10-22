"use client";

import { usePathname, useRouter } from "next/navigation";
import { DropdownMenu as M } from "radix-ui";
import { ROLE_LABELS } from "@pisowifi/shared";
import { API_MODE, NAV, routeKeyFor } from "@/lib/constants";
import { getServices } from "@/lib/services";
import { useDemo } from "@/stores/demo-store";
import { toast } from "@/stores/toast-store";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/button";
import { useEffectiveTheme } from "@/components/shell/theme-sync";
import { switchTheme } from "@/lib/theme-transition";

function initials(name: string) {
  const n = (name || "O").trim().split(/\s+/);
  return (n[0][0] + (n[1] ? n[1][0] : "")).toUpperCase();
}

/** Sticky header: menu (mobile), title + subtitle, Demo badge (not on the Dashboard), machine search, refresh, theme,
 *  account menu. */
export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const route = NAV.find((n) => n.key === routeKeyFor(pathname))!;
  const mq = useDemo((s) => s.mq);
  const drawer = useDemo((s) => s.drawer);
  const profile = useDemo((s) => s.profile);
  // The signed-in user's own role (from the server in API mode): Administrator or Member.
  const role = useDemo((s) => s.role);
  const patch = useDemo((s) => s.patch);
  const setView = useDemo((s) => s.setView);
  const dark = useEffectiveTheme() === "dark";
  const toggleTheme = () => switchTheme(dark ? "light" : "dark");

  const refresh = () => {
    if (API_MODE) {
      void getServices().machines.list().then(
        () => toast("Machine status refreshed."),
        () => toast("Could not refresh machines. Check your connection."),
      );
      return;
    }
    setView("loading");
    setTimeout(() => {
      if (useDemo.getState().view === "loading") {
        setView("normal");
        toast("Refreshed. Demo data only, nothing live was fetched.");
      }
    }, 800);
  };

  const logout = async () => {
    await getServices().auth.signOut();
    router.replace("/login");
    toast("Signed out");
  };

  return (
    <header className="pw-top">
      <IconButton icon="menu" className="burger" aria-label="Open navigation menu" aria-expanded={drawer} onClick={() => patch({ drawer: true })} />
      <div className="pw-grow">
        <h1 className="pw-h1">{route.title}</h1>
        <div className="pw-small pw-muted">{route.subtitle}</div>
      </div>
      <label className="pw-search">
        <Icon name="search" size={18} />
        <input
          id="gsearch"
          value={mq}
          placeholder="Search machines…"
          aria-label="Search machines"
          onChange={(e) => {
            patch({ mq: e.target.value });
            if (pathname !== "/machines") {
              patch({ view: "normal" });
              router.push("/machines");
            }
          }}
        />
      </label>
      <IconButton
        icon="refresh"
        aria-label={API_MODE ? "Refresh machine status" : "Refresh demo data"}
        title={API_MODE ? "Refresh machine status" : "Refresh (demo)"}
        onClick={refresh}
      />
      <IconButton
        icon={dark ? "sun" : "moon"}
        aria-label={"Switch to " + (dark ? "light" : "dark") + " theme"}
        title={"Switch to " + (dark ? "light" : "dark") + " theme"}
        className="theme-btn"
        onClick={toggleTheme}
      />
      <M.Root modal={false}>
        <div className="menu-wrap">
          <M.Trigger asChild>
            <button type="button" className="who" aria-label="Account menu">
              <span className="pw-avatar">{initials(profile.name)}</span>
              <span className="wt" style={{ lineHeight: "16px", textAlign: "left" }}>
                <span className="pw-small" style={{ color: "var(--ink)", display: "block" }}>
                  {profile.name}
                </span>
                <span className="pw-small pw-muted" style={{ display: "block" }}>
                  {ROLE_LABELS[role]}
                </span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          </M.Trigger>
          <M.Portal>
            <M.Content className="menu" align="end" sideOffset={8} style={{ position: "static" }}>
              {/* Name and role are hidden in the trigger on narrow screens, so the menu always repeats them. */}
              <div className="mi pw-small" style={{ minHeight: 32, display: "block" }}>
                <span style={{ color: "var(--ink)", display: "block" }}>{profile.name}</span>
                <span className="pw-muted" style={{ display: "block" }}>
                  {ROLE_LABELS[role]} · {profile.email}
                </span>
              </div>
              <hr />
              <M.Item asChild onSelect={() => router.push("/settings/profile")}>
                <button type="button">
                  <Icon name="user" />
                  Profile
                </button>
              </M.Item>
              <M.Item asChild onSelect={() => router.push("/settings/security")}>
                <button type="button">
                  <Icon name="lock" />
                  Security
                </button>
              </M.Item>
              <M.Item asChild onSelect={toggleTheme}>
                <button type="button">
                  <Icon name={dark ? "sun" : "moon"} />
                  {dark ? "Light" : "Dark"} theme
                </button>
              </M.Item>
              <hr />
              <M.Item asChild onSelect={logout}>
                <button type="button">
                  <Icon name="logout" />
                  Sign out
                </button>
              </M.Item>
            </M.Content>
          </M.Portal>
        </div>
      </M.Root>
    </header>
  );
}
