"use client";

import type { ReactNode } from "react";
import { useDemo } from "@/stores/demo-store";
import { useHydrated } from "@/hooks/use-hydrated";
import { ErrorState, PageSkeleton } from "@/components/ui/states";
import { PageHead } from "@/components/demo/page-head";

/** Renders the page's loading / error states (e.g. while the header's Refresh runs), otherwise the page itself.
 *  `empty` is handled by each page, because each page has its own empty state. */
export function ViewGate({
  kpi,
  actions,
  machines = true,
  children,
}: {
  kpi?: boolean;
  actions?: ReactNode;
  /** page needs the machine list: show the skeleton while it loads (API mode) instead of the empty state */
  machines?: boolean;
  children: () => ReactNode;
}) {
  const hydrated = useHydrated();
  const view = useDemo((s) => s.view);
  const machinesLoading = useDemo((s) => s.machinesLoading);
  const setView = useDemo((s) => s.setView);
  if (!hydrated || view === "loading" || (machines && machinesLoading))
    return (
      <>
        <PageHead />
        <PageSkeleton kpi={kpi} />
      </>
    );
  if (view === "error")
    return (
      <>
        <PageHead />
        <ErrorState onRetry={() => setView("normal")} />
      </>
    );
  return (
    <>
      <PageHead actions={actions} />
      {children()}
    </>
  );
}
