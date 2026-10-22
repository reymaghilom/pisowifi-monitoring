import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/states";
import { HistoryView } from "@/components/features/history/history-view";

export default function HistoryPage() {
  return (
    <Suspense fallback={<PageSkeleton kpi />}>
      <HistoryView />
    </Suspense>
  );
}
