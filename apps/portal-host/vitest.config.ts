import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: "default",
    // The journey/composition suites boot an embedded REAL PostgreSQL
    // (pglite) and apply the real infra/migrations; under a full-workspace
    // parallel run that boot can exceed vitest's 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
