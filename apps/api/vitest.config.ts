import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Several files run migrations on PGlite and hash passwords with Argon2 in parallel; give them room on slow machines.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each file holds its own in-memory PGlite (WASM) instance; too many at once crashed workers on Windows.
    maxWorkers: 2,
  },
});
