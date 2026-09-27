import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_PERSONA,
  DEFAULT_CUSTOMER,
  SKIP_REASON_ENV_NOT_CONFIGURED,
  configFromEnv,
} from "../src/config.js";

describe("the env contract (fail-closed to skip)", () => {
  it("no env at all → the NAMED skip, never a throw, never a configured run", () => {
    const config = configFromEnv({});
    expect(config.status).toBe("skipped");
    if (config.status !== "skipped") throw new Error("unreachable");
    expect(config.skipReason).toBe(SKIP_REASON_ENV_NOT_CONFIGURED);
    expect(config.skipReason).toContain("ACCEPTANCE_BASE_URL_NOT_CONFIGURED");
    expect("baseUrl" in config).toBe(false);
    // The persona defaults still resolve (the public roster fixtures).
    expect(config.customer.email).toBe(DEFAULT_CUSTOMER.email);
    expect(config.adminPersona.email).toBe(DEFAULT_ADMIN_PERSONA.email);
  });

  it("empty-string env values count as unset", () => {
    const config = configFromEnv({ ACCEPTANCE_BASE_URL: "   " });
    expect(config.status).toBe("skipped");
  });

  it("a configured origin yields a bare, normalized base URL", () => {
    const config = configFromEnv({ ACCEPTANCE_BASE_URL: "https://roamlink-ten.vercel.app" });
    expect(config.status).toBe("configured");
    if (config.status !== "configured") throw new Error("unreachable");
    expect(config.baseUrl).toBe("https://roamlink-ten.vercel.app");
  });

  it("a trailing slash is normalized away", () => {
    const config = configFromEnv({ ACCEPTANCE_BASE_URL: "http://127.0.0.1:8080/" });
    expect(config.status).toBe("configured");
    if (config.status !== "configured") throw new Error("unreachable");
    expect(config.baseUrl).toBe("http://127.0.0.1:8080");
  });

  it("a malformed origin is an honest misconfiguration (throw, not a skip)", () => {
    expect(() => configFromEnv({ ACCEPTANCE_BASE_URL: "not-a-url" })).toThrow(/absolute origin/);
    expect(() => configFromEnv({ ACCEPTANCE_BASE_URL: "https://host/some/path" })).toThrow(/bare origin/);
    expect(() => configFromEnv({ ACCEPTANCE_BASE_URL: "https://host?q=1" })).toThrow(/bare origin/);
  });

  it("optional credential envs override the public roster defaults", () => {
    const config = configFromEnv({
      ACCEPTANCE_BASE_URL: "https://demo.example.org",
      ACCEPTANCE_DEMO_EMAIL: "someone@example.org",
      ACCEPTANCE_DEMO_PASSWORD: "their-password",
      ACCEPTANCE_ADMIN_EMAIL: "admin@example.org",
    });
    expect(config.status).toBe("configured");
    expect(config.customer.email).toBe("someone@example.org");
    expect(config.customer.password).toBe("their-password");
    expect(config.adminPersona.email).toBe("admin@example.org");
  });

  it("a malformed timeout refuses to run rather than guessing", () => {
    expect(() =>
      configFromEnv({ ACCEPTANCE_BASE_URL: "https://demo.example.org", ACCEPTANCE_TIMEOUT_MS: "soon" }),
    ).toThrow(/ACCEPTANCE_TIMEOUT_MS/);
  });

  it("the timeout is bounded", () => {
    const config = configFromEnv({
      ACCEPTANCE_BASE_URL: "https://demo.example.org",
      ACCEPTANCE_TIMEOUT_MS: "999999999",
    });
    expect(config.timeoutMs).toBeLessThanOrEqual(180_000);
  });
});
