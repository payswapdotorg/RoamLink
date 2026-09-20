import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: "default",
    // The drain/host tests boot an embedded REAL PostgreSQL (pglite) and
    // apply the real infra/migrations. Under a full-workspace parallel run
    // the engine boot + migration round-trip can exceed vitest's 5s default
    // - the work is real, not hung, so the budget is sized for the loaded
    // case (same discipline as packages/persistence-postgres).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
