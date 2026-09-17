import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: "default",
    // Load-shaped suites execute VOLUME (thousands of events); the generous
    // per-test ceiling is execution headroom only - every assertion is a
    // deterministic operation COUNT on the testkit clock, never wall-clock
    // timing (RL-073: deterministic load, no benchmarks).
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
