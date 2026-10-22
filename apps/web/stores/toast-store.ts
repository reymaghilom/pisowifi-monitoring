"use client";

import { create } from "zustand";

export interface ToastItem {
  id: number;
  msg: string;
  kind: "ok" | "bad";
}

interface ToastState {
  toasts: ToastItem[];
  push: (msg: string, kind?: "ok" | "bad") => void;
}

let next = 1;

export const useToasts = create<ToastState>()((set) => ({
  toasts: [],
  push: (msg, kind = "ok") => {
    const id = next++;
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3600);
  },
}));

/** Show a toast (bottom centre, 3.6 s), as in the prototype. */
export function toast(msg: string, kind: "ok" | "bad" = "ok") {
  useToasts.getState().push(msg, kind);
}

export function copyText(text: string, okMsg: string) {
  try {
    navigator.clipboard.writeText(text).then(
      () => toast(okMsg),
      () => toast("Clipboard is blocked in this view.", "bad"),
    );
  } catch {
    toast("Clipboard is blocked in this view.", "bad");
  }
}
