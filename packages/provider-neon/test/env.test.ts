import { describe, expect, it } from "vitest";
import { tryParseNeonEnv } from "../src/index.js";

const VALID = "postgresql://owner:s3cret@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";

describe("tryParseNeonEnv (RL-095)", () => {
  it("parses a present DATABASE_URL into the validated Neon config", () => {
    const result = tryParseNeonEnv({ DATABASE_URL: VALID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.pooledEndpoint).toBe(true);
    expect(result.config.database).toBe("neondb");
  });

  it("fails naming the KEY only when DATABASE_URL is absent or blank", () => {
    for (const source of [{}, { DATABASE_URL: "" }, { DATABASE_URL: "   " }]) {
      const result = tryParseNeonEnv(source);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const err = result.error as Error;
      expect(err.message).toContain("DATABASE_URL");
      expect(err.message).not.toContain("s3cret");
    }
  });

  it("fails closed on an invalid connection string without echoing values", () => {
    const result = tryParseNeonEnv({ DATABASE_URL: "postgresql://owner:s3cret@ep-x.neon.tech/neondb?sslmode=disable" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.error as Error & { details?: readonly { path: string; issue: string }[] };
    const detailText = JSON.stringify(err.details ?? []);
    expect(detailText).toContain("sslmode");
    expect(err.message).not.toContain("s3cret");
    expect(detailText).not.toContain("s3cret");
  });
});
