import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/states";
import { AutomationsView } from "@/components/features/automations/automations-view";

export default function AutomationsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AutomationsView />
    </Suspense>
  );
}
