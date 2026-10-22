"use client";

import { useRouter } from "next/navigation";
import { useDemo } from "@/stores/demo-store";
import { useCan } from "@/lib/permissions";
import { API_MODE, REMOTE_MODE } from "@/lib/constants";

/** Whether the signed-in user may add, edit, pause or delete machines (permission machines:manage: Administrators).
 *  Mock mode: always (demo). This only hides controls; the API refuses Member writes regardless. */
export function useCanManageMachines() {
  const allowed = useCan("machines:manage");
  return !API_MODE || allowed;
}

/** Navigation helpers shared by every screen (prototype's open-detail / open-remote / open-hist). */
export function useMachineNav() {
  const router = useRouter();
  return {
    openDetail: (id: string) => {
      useDemo.getState().selectMachine(id);
      router.push("/machines/" + id);
    },
    openRemote: (id: string) => {
      if (REMOTE_MODE === "disabled") return;
      useDemo.getState().selectMachine(id);
      useDemo.getState().patch({ remote: { ...useDemo.getState().remote, m: id } });
      router.push("/remote?machine=" + id);
    },
    openHistory: (id: string) => {
      useDemo.getState().patch({ hist: { ...useDemo.getState().hist, m: id, page: 0 } });
      router.push("/history?machine=" + id);
    },
    add: () => useDemo.getState().openModal({ type: "form", id: null }),
    edit: (id: string) => useDemo.getState().openModal({ type: "form", id }),
    del: (id: string) => useDemo.getState().openModal({ type: "delete", id }),
  };
}
