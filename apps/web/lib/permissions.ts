/* Role-aware UI, from the same permission map the API enforces (@pisowifi/shared can()). This only decides what to
   show: the API refuses anything a role doesn't hold, whatever the page displays. Mock (demo) mode signs in as an
   Administrator, so the demo keeps every control. */
import { ROLE_LABELS, can, type Permission, type Role } from "@pisowifi/shared";
import { useDemo } from "@/stores/demo-store";

export function useCan(permission: Permission): boolean {
  return can(useDemo((s) => s.role), permission);
}

export const roleLabel = (role: Role) => ROLE_LABELS[role];
