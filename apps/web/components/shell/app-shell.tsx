"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { DATA_SOURCE, getServices } from "@/lib/services";
import { toast } from "@/stores/toast-store";
import { useDemo } from "@/stores/demo-store";
import { useHydrated } from "@/hooks/use-hydrated";
import { useSession, verifySession } from "@/lib/session";
import { Sidebar } from "@/components/shell/sidebar";
import { Header } from "@/components/shell/header";
import { MobileDrawer } from "@/components/shell/mobile-drawer";
import { MachineDialogs } from "@/components/features/machines/machine-dialogs";

export const MACHINE_REFRESH_MS = 30_000;

/** Authenticated layout: sidebar, sticky header, main column, mobile drawer.
 *  Always renders its children (Next validates every segment); pages show their skeleton until the
 *  demo state is restored. Auth guard: signed-out visitors go to /login. With the API data source the
 *  session cookie is checked against the server on load (an expired or revoked session signs out). */
export function AppShell({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const auth = useDemo((s) => s.auth);
  const session = useSession((s) => s.status);
  const allowed = DATA_SOURCE === "api" ? session === "authenticated" : auth;
  const collapsed = useDemo((s) => s.collapsed);
  const router = useRouter();
  const pathname = usePathname();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  // Sidebar collapse animates only after the saved layout is in place, so a collapsed sidebar doesn't animate shut on load.
  const [motion, setMotion] = useState(false);

  useEffect(() => {
    if (hydrated && (DATA_SOURCE === "api" ? session === "unauthenticated" : !auth)) router.replace("/login");
  }, [hydrated, auth, session, router]);

  useEffect(() => {
    if (!hydrated) return;
    let id = requestAnimationFrame(() => (id = requestAnimationFrame(() => setMotion(true))));
    return () => cancelAnimationFrame(id);
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || !allowed || DATA_SOURCE !== "api") return;
    const svc = getServices();
    let cancelled = false;
    let pending = false;
    const refresh = async (initial = false) => {
      if (cancelled || pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        await svc.machines.list();
      } catch {
        if (initial && !cancelled) toast("Could not load machines. Check your connection and reload.");
      } finally {
        pending = false;
      }
    };
    void refresh(true);
    const timer = setInterval(() => void refresh(), MACHINE_REFRESH_MS);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [hydrated, allowed]);

  // Route change: reset preview state, close overlays, scroll to top, focus main, play route-in.
  useEffect(() => {
    useDemo.getState().patch({ view: "normal", drawer: false, modal: null });
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    const m = mainRef.current;
    if (m) {
      m.focus({ preventScroll: true });
      m.classList.remove("route-in");
      void m.offsetWidth;
      m.classList.add("route-in");
    }
  }, [pathname]);

  if (DATA_SOURCE === "api" && session === "error") return (
    <main className="pw-page" role="alert">
      <h1>Could not verify your session</h1>
      <p>Check your connection, then try again.</p>
      <button type="button" onClick={() => void verifySession(() => getServices().auth.currentUser())}>Try again</button>
    </main>
  );
  if (!hydrated || !allowed) return <div style={{ minHeight: "100vh", background: "var(--bg)" }} aria-busy="true" />;

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className={cn("pw-app", collapsed && "collapsed", !motion && "no-motion")}>
        <Sidebar />
        <div className="pw-main-col">
          <Header />
          <main id="main" ref={mainRef} className="pw-page" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <MobileDrawer />
      <MachineDialogs />
    </>
  );
}
