import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: "default",
    // Every test boots an embedded REAL PostgreSQL (pglite) and applies the
    // real infra/migrations. Under a full-workspace parallel run the engine
    // boot + migration round-trip can exceed vitest's 5s default - the work
    // is real, not hung, so the per-test budget is sized for the loaded case.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
