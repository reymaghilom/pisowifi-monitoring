import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { useDemo } from "@/stores/demo-store";
import { useToasts } from "@/stores/toast-store";
import { setServicesForTesting } from "@/lib/services";

/* Every test starts from the seeded demo state with no toasts and the real mock services. */
const initialDemo = useDemo.getState();

beforeEach(() => {
  sessionStorage.clear();
  useDemo.setState(initialDemo, true);
  useToasts.setState({ toasts: [] });
  setServicesForTesting(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* next/navigation: a shared router spy and controllable params. */
export const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
export const nav = { pathname: "/dashboard", params: {} as Record<string, string>, search: new URLSearchParams() };

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => nav.pathname,
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
  redirect: vi.fn(),
}));

beforeEach(() => {
  Object.values(router).forEach((f) => f.mockReset());
  nav.pathname = "/dashboard";
  nav.params = {};
  nav.search = new URLSearchParams();
});

/* jsdom lacks these browser APIs used by charts and theme detection. */
if (!window.matchMedia) {
  window.matchMedia = (q: string) =>
    ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, onchange: null, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}
if (!("ResizeObserver" in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
