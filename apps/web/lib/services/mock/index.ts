/* Mock services: the demo store is the "database", the seeded engine the "monitor".
   Latencies reproduce the prototype's timings (sign-in 900 ms, demo check 900 ms). */
import type { Services } from "@/lib/services/types";
import {
  hasErrors,
  validateMachine,
  validateMonitoring,
  validateNewPassword,
  validatePasswordChange,
  validateProfile,
  validateResetEmail,
} from "@/lib/validation";
import { STATUS_LABEL } from "@/lib/constants";
import { machineById } from "@/lib/domain/machines";
import { useDemo } from "@/stores/demo-store";
import { createMockUsersService } from "@/lib/services/mock/users";

export const MOCK_LATENCY = { signIn: 900, check: 900 };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const store = () => useDemo.getState();

export function createMockServices(): Services {
  return {
    auth: {
      async signIn({ password, remember }) {
        await wait(MOCK_LATENCY.signIn);
        if (password !== "demo") return { ok: false, error: "Invalid email or password. (Demo: the password is “demo”.)" };
        store().signIn(remember);
        return { ok: true };
      },
      async currentUser() {
        const s = store();
        return s.auth ? { ...s.profile, role: "admin" } : null;
      },
      async signOut() {
        store().signOut();
      },
      async requestPasswordReset(email) {
        const error = validateResetEmail(email);
        return error ? { ok: false, error } : { ok: true };
      },
      async confirmPasswordReset(_token, pw, cf) {
        const error = validateNewPassword(pw, cf);
        return hasErrors(error) ? { ok: false, error } : { ok: true };
      },
    },

    machines: {
      async list() {
        return store().machines;
      },
      async create(input) {
        const errors = validateMachine(input, store().machines, null);
        if (hasErrors(errors)) return { ok: false, error: errors };
        const id = store().addMachine(input);
        return { ok: true, machine: machineById(store().machines, id)! };
      },
      async update(id, input) {
        const errors = validateMachine(input, store().machines, id);
        if (hasErrors(errors)) return { ok: false, error: errors };
        store().updateMachine(id, input);
        return { ok: true, machine: machineById(store().machines, id)! };
      },
      async remove(id) {
        store().deleteMachine(id);
      },
      async runCheck(ids) {
        await wait(MOCK_LATENCY.check);
        store().recordCheck(ids);
      },
      async toggleMonitoring(id) {
        return store().toggleMonitor(id);
      },
      async simulateStatus(id, status) {
        store().setMachineStatus(id, status, status ? STATUS_LABEL[status] : "");
      },
    },

    settings: {
      async saveProfile(p) {
        const error = validateProfile(p.name, p.email);
        if (hasErrors(error)) return { ok: false, error };
        store().patch({ profile: { name: p.name, email: p.email } });
        return { ok: true };
      },
      async changePassword(cur, nw, cf) {
        const error = validatePasswordChange(cur, nw, cf);
        return hasErrors(error) ? { ok: false, error } : { ok: true };
      },
      async listSessions() {
        return store().sessions;
      },
      async signOutSession(id) {
        store().patch({ sessions: store().sessions.filter((s) => s.id !== id) });
      },
      async signOutOtherSessions() {
        store().patch({ sessions: store().sessions.filter((s) => s.cur) });
      },
      async saveMonitoring(m) {
        const error = validateMonitoring(m.timeout, m.thr);
        if (hasErrors(error)) return { ok: false, error };
        store().patch({ mon: m });
        return { ok: true };
      },
      async setNotification(key, on) {
        store().patch({ notif: { ...store().notif, [key]: on } });
      },
    },

    users: createMockUsersService(),

    automations: {
      async setRule(rule, on) {
        const auto = store().auto;
        store().patch({ auto: { ...auto, rules: { ...auto.rules, [rule]: on } } });
      },
    },
  };
}
