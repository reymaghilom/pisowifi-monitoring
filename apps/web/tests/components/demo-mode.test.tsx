import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/* DEMO_MODE is read once at import time, so each case re-imports the module with the env stubbed. */
async function renderHead(flag: string) {
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", flag);
  vi.resetModules();
  const { PageHead } = await import("@/components/demo/page-head");
  return render(<PageHead actions={<button>Add machine</button>} />);
}

afterEach(() => vi.unstubAllEnvs());

describe("page head", () => {
  for (const flag of ["true", "false"]) {
    it(`has no Preview state select and keeps page actions (NEXT_PUBLIC_DEMO_MODE=${flag})`, async () => {
      await renderHead(flag);
      expect(screen.queryByLabelText("Preview page state")).not.toBeInTheDocument();
      expect(screen.queryByText("Preview state")).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add machine" })).toBeInTheDocument();
    });
  }
});
