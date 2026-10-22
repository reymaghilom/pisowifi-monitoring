import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/states";
import { RemoteView } from "@/components/features/remote/remote-view";

export default function RemotePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RemoteView />
    </Suspense>
  );
}
