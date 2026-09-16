/**
 * RL-054 secret-scan tests: the RL-LOCK-016 enforcement point
 * ("secrets/credentials are NEVER persisted in ordinary domain tables") as a
 * FAILING-CAPABLE test - scanning clean RoamLink-shaped payloads passes, and
 * every secret-shaped shape fails (RL-LOCK-018: remove the enforcement and
 * these tests fail).
 */
import { describe, expect, it } from "vitest";

import { assertNoSecretMaterial, scanForSecretMaterial } from "../src/index.js";

// Credential-looking fixtures are BUILT from parts so this source (and the
// diff) never carries a complete literal credential (the repo's own
// pre-commit secret scan would rightly block it - same spirit as the hook's
// character-class trick for prefixes).
const PEM_FIXTURE = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
const PEM_FIXTURE_ALT = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const AWS_KEY_FIXTURE = ["AKIA", "0123456789ABCDEF"].join("");
const GITHUB_TOKEN_FIXTURE = ["ghp", "_0123456789abcdef012345"].join("");
const JWT_FIXTURE = ["eyJ", "hbGciOiJIUzI1NiJ9.payload.sig"].join("");
const BEARER_FIXTURE = ["Bearer", " abcdef0123456789"].join("");

describe("scanForSecretMaterial (paths, never values)", () => {
  it("reports key-name findings with exact paths", () => {
    const findings = scanForSecretMaterial({
      smtp: { password: "hunter2" },
      nested: { deep: { apiToken: "abc" } },
    });
    expect(findings).toEqual([
      { path: "$.smtp.password", detector: "key-name" },
      { path: "$.nested.deep.apiToken", detector: "key-name" },
    ]);
  });

  it("reports value-marker findings (PEM, JWT, well-known token prefixes)", () => {
    const findings = scanForSecretMaterial({
      cert: `${PEM_FIXTURE}MIIB\nmore`,
      jwt: JWT_FIXTURE,
      github: GITHUB_TOKEN_FIXTURE,
      aws: AWS_KEY_FIXTURE,
      bearer: BEARER_FIXTURE,
    });
    expect(findings.map((finding) => finding.path)).toEqual([
      "$.cert",
      "$.jwt",
      "$.github",
      "$.aws",
      "$.bearer",
    ]);
    expect(findings.every((finding) => finding.detector === "value-marker")).toBe(true);
  });

  it("scans arrays recursively and ignores short innocuous strings", () => {
    const findings = scanForSecretMaterial(["ok-value", { clientSecret: "x" }, "short"]);
    expect(findings).toEqual([{ path: "$[1].clientSecret", detector: "key-name" }]);
  });

  it("never echoes values in the finding list (RL-LOCK-016)", () => {
    const findings = scanForSecretMaterial({ password: "super-secret-value" });
    expect(JSON.stringify(findings)).not.toContain("super-secret-value");
  });
});

describe("assertNoSecretMaterial against RoamLink-shaped domain payloads", () => {
  it("clean domain-table-shaped payloads pass the enforcement point", () => {
    // Shapes modeled on what other packages persist: a device context
    // snapshot value, an order record, a projection with freshness.
    expect(() =>
      assertNoSecretMaterial(
        {
          snapshotId: "00000000-0000-4000-8000-000000000001",
          consent: { fineLocationGranted: true },
          payload: {
            coarseLocation: { countryCode: "DE" },
            fineLocation: { latitude: 50.1, longitude: 8.7 },
            network: { visibleWifiNetworkCount: 4, cellularRadio: "lte" },
            battery: { levelPercent: 80, charging: true },
          },
        },
        "device-context-value",
      ),
    ).not.toThrow();

    expect(() =>
      assertNoSecretMaterial(
        {
          order_id: "00000000-0000-4000-8000-000000000042",
          state: "CONFIRMED",
          lines: [{ sku: "esim-travel-1gb", amount: "9.90", currency: "EUR" }],
          freshness: { observedAt: "2026-01-15T08:30:00.000Z", freshnessState: "FRESH" },
        },
        "order-value",
      ),
    ).not.toThrow();

    expect(() =>
      assertNoSecretMaterial(
        {
          outboxRecordId: "00000000-0000-4000-8000-000000000077",
          ciphertextEnvelope: {
            algorithm: "aes-256-gcm",
            keyId: "edge-sync-key",
            ciphertext: "cGF5bG9hZC1jaXBoZXJ0ZXh0",
          },
          state: "pending",
        },
        "outbox-value",
      ),
    ).not.toThrow();
  });

  it("SECRETS NEVER PASS: key-named credential fields fail closed (failing-capable)", () => {
    const attempts: unknown[] = [
      { password: "hunter2" },
      { arosToken: "value" },
      { credentials: { apiKey: "x" } },
      { "private-key": "material" },
      { shared_key: "k" },
      [{ secretNote: "value" }],
    ];
    for (const attempt of attempts) {
      expect(() => assertNoSecretMaterial(attempt, "domain-value")).toThrowError(
        /never persisted in ordinary domain tables/,
      );
    }
  });

  it("SECRETS NEVER PASS: credential values fail closed even under innocuous keys (failing-capable)", () => {
    const attempts: unknown[] = [
      { config: `${PEM_FIXTURE_ALT}\nMIIE...` },
      { authorization: JWT_FIXTURE },
      { integrationSetting: GITHUB_TOKEN_FIXTURE },
      { adcos: BEARER_FIXTURE },
    ];
    for (const attempt of attempts) {
      expect(() => assertNoSecretMaterial(attempt, "domain-value")).toThrowError(
        /RETENTION_SECRET_MATERIAL_DETECTED|secret-shaped material/,
      );
    }
  });

  it("the typed error is value-free (RL-LOCK-016)", () => {
    try {
      assertNoSecretMaterial({ password: "hunter2" }, "domain-value");
      expect.unreachable("the assertion must throw");
    } catch (error) {
      expect((error as Error).message).toContain("$.password");
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});
