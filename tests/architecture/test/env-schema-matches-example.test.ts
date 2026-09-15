import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_KEYS } from "@roamlink/contracts";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * RL-001: the typed env schema in packages/contracts must match
 * .env.example EXACTLY - same key set, same canonical order. A new key added
 * to one but not the other fails this test.
 */
describe("env schema matches .env.example exactly (RL-001)", () => {
  it(".env.example keys and ENV_KEYS are identical (set and order)", () => {
    const example = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const exampleKeys = example
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=")[0])
      .filter((key) => key !== undefined && /^[A-Z][A-Z0-9_]*$/.test(key));

    expect(exampleKeys).toEqual([...ENV_KEYS]);
  });
});
