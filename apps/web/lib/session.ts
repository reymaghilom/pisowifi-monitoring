import { create } from "zustand";
import { useDemo } from "@/stores/demo-store";
import type { SignedInUser } from "@/lib/services/types";

export type SessionStatus = "pending" | "authenticated" | "unauthenticated" | "error";
export const useSession = create<{ status: SessionStatus }>(() => ({ status: "pending" }));

let generation = 0;
let inFlight: Promise<void> | null = null;

export function setSessionStatus(status: SessionStatus) {
  generation++;
  useSession.setState({ status });
}

/** The HttpOnly cookie, checked by /auth/me, is the authority. Saved UI state never grants access. */
export function verifySession(currentUser: () => Promise<SignedInUser | null>): Promise<void> {
  if (inFlight) return inFlight;
  const attempt = ++generation;
  useSession.setState({ status: "pending" });
  const check = currentUser().then(
    (user) => {
      if (attempt !== generation) return;
      if (!user) {
        useDemo.getState().signOut();
        useSession.setState({ status: "unauthenticated" });
        return;
      }
      const state = useDemo.getState();
      state.patch({ profile: { name: user.name, email: user.email }, role: user.role, uid: user.id ?? null });
      state.signIn(state.remember);
      useSession.setState({ status: "authenticated" });
    },
    () => {
      if (attempt !== generation) return;
      useDemo.getState().signOut();
      useSession.setState({ status: "error" });
    },
  ).finally(() => { if (inFlight === check) inFlight = null; });
  inFlight = check;
  return check;
}
