"use client";

import { getServices } from "@/lib/services";
import { API_MODE } from "@/lib/constants";
import { useDemo } from "@/stores/demo-store";
import { toast } from "@/stores/toast-store";

/** "Run check now (demo)": shared busy flag (spinner on every check button), service call, then a toast.
 *  API mode: live checks arrive with monitoring (B8); nothing runs and no status changes. */
export function useRunCheck() {
  const busy = useDemo((s) => s.busy);
  const run = async (ids: string[], doneMsg: string) => {
    if (API_MODE) return toast("Live checks run on the monitoring worker. The last verified status is unchanged.");
    useDemo.getState().patch({ busy: true });
    try {
      await getServices().machines.runCheck(ids);
    } finally {
      useDemo.getState().patch({ busy: false });
    }
    toast(doneMsg);
  };
  return { busy, run };
}
