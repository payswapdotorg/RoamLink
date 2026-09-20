import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: "default",
    // Each journey boots its own REAL hosted composition (embedded
    // PostgreSQL + the real infra/migrations); boot + scrypt registration
    // are real work, so the per-test budget is generous but bounded.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
