"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useDemo } from "@/stores/demo-store";
import { useHydrated } from "@/hooks/use-hydrated";
import { DATA_SOURCE } from "@/lib/services";
import { useSession } from "@/lib/session";

/** "/" goes to the dashboard when signed in (mock), otherwise to sign-in. */
export function RootRedirect() {
  const router = useRouter();
  const hydrated = useHydrated();
  const session = useSession((s) => s.status);
  useEffect(() => {
    if (!hydrated) return;
    if (DATA_SOURCE === "api") {
      if (session !== "pending") router.replace(session === "authenticated" ? "/dashboard" : "/login");
    } else router.replace(useDemo.getState().auth ? "/dashboard" : "/login");
  }, [hydrated, session, router]);
  return <div style={{ minHeight: "100vh", background: "var(--bg)" }} aria-busy="true" />;
}
