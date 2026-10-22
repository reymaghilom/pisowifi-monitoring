"use client";

import { useSyncExternalStore } from "react";
import { useDemo } from "@/stores/demo-store";

const subscribe = (cb: () => void) => useDemo.persist.onFinishHydration(cb);

/** True once the session's demo state has been restored in the browser (false on the server). */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => useDemo.persist.hasHydrated(),
    () => false,
  );
}
