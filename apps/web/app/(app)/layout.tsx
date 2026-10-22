import { Suspense } from "react";
import { AppShell } from "@/components/shell/app-shell";

/* The shell reads the pathname (active nav, page title), which on dynamic routes like
   /machines/[id] is only known at request time, so it renders inside Suspense. */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "var(--bg)" }} aria-busy="true" />}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
