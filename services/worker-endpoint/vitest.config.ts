import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: "default",
    // The execution-facts battery boots the REAL services/api composition
    // over an embedded real PostgreSQL (pglite) with the real infra/
    // migrations, then drives the REAL tick endpoint end to end - the work
    // is real, not hung, so the budget is sized for the loaded case (same
    // discipline as services/workers).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
