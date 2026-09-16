/**
 * Spec drift guard: every resource path listed in spec/api.md must exist in
 * the typed client's route table ("generated from or checked against the API
 * contract", RL-060). Additive routes beyond the spec list are allowed (the
 * spec lists "representative resources"); REMOVING a spec-listed resource
 * fails this test.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { API_ROUTE_TEMPLATES } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const SPEC = join(REPO_ROOT, "spec", "api.md");

describe("the route table covers the spec-listed API resources (spec/api.md)", () => {
  it("spec/api.md exists and lists resources", () => {
    expect(existsSync(SPEC)).toBe(true);
    const spec = readFileSync(SPEC, "utf8");
    const tokens = spec.match(/`\/v1\/[a-z-]+`/g) ?? [];
    expect(tokens.length).toBeGreaterThanOrEqual(10);
  });

  it("every spec-listed resource path is a prefix of a route template", () => {
    const spec = readFileSync(SPEC, "utf8");
    const listed = [...new Set((spec.match(/`\/v1\/[a-z-]+`/g) ?? []).map((t) => t.slice(1, -1)))];
    expect(listed.length).toBeGreaterThan(0);
    const templates = Object.values(API_ROUTE_TEMPLATES);
    const missing = listed.filter(
      (resource) => !templates.some((template) => template.startsWith(resource)),
    );
    expect(
      missing,
      `spec-listed resources missing from the route table: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
