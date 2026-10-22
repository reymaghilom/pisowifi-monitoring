/* Single entry point for data access. Components call getServices(), never the store's write actions.
   NEXT_PUBLIC_DATA_SOURCE selects the implementation:
   - "mock" (default): everything simulated in the browser (demo sign-in, password "demo").
   - "api": real sign-in, session and sign-out against the API (proxied at /api/v1, see next.config.ts);
     machines (B6) and account settings too; monitoring results, history, notifications and automations stay
     simulated until their backend milestones. */
import type { Services } from "@/lib/services/types";
import { createMockServices } from "@/lib/services/mock";
import { createApiServices } from "@/lib/services/api";
import { DATA_SOURCE } from "@/lib/constants";

export { DATA_SOURCE };

let instance: Services | null = null;

export function getServices(): Services {
  if (!instance) {
    if (DATA_SOURCE === "api") instance = createApiServices();
    else if (DATA_SOURCE === "mock") instance = createMockServices();
    else throw new Error(`Unknown data source "${DATA_SOURCE}". Use "mock" or "api".`);
  }
  return instance;
}

/** Tests only: replace the implementation (e.g. with a fake) and restore it afterwards. */
export function setServicesForTesting(s: Services | null) {
  instance = s;
}

export type { Services } from "@/lib/services/types";
