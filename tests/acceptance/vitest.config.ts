import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: "default",
    // The selftest boots a loopback-only fixture site and (when the sandbox
    // has a real browser) launches headless Chromium against it: both are
    // real work, so the per-test budget is generous but bounded. Every leg
    // stays offline (loopback only) - no deployed URL is ever contacted by
    // the selftest.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
