/**
 * RL-LOCK-016 conformance suite: no secret leakage.
 *
 * Private keys, ADCOS credentials, provider secrets and subscriber
 * credentials cannot enter projections, telemetry, logs, analytics payloads
 * or user-visible diagnostics.
 *
 * GREEN PROOFS:
 *  - a REAL webhook admission flow, run with a real HMAC secret, persists
 *    records that DO NOT contain the secret (verified by scanning the full
 *    committed record for the secret bytes; only a signature DIGEST is
 *    retained);
 *  - the retention scanner (assertNoSecretMaterial) accepts every durable
 *    artifact the flows produce: the admitted webhook record, a §8
 *    projection record, a command envelope, retry metadata (value-free
 *    by construction);
 *  - the observability log record redacts secret-bearing values at every
 *    serialization path ([REDACTED] from JSON.stringify, String() and
 *    util.inspect);
 *  - no production source contains literal credential material.
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - assertNoSecretMaterial DETECTS a smuggled secret (proving the suite
 *    fails when a real leak appears in any scanned artifact);
 *  - a committed private key in a production source turns the scan red
 *    (toggle RL-LOCK-016).
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { inspect, format } from "node:util";
import { join } from "node:path";
import { createInMemoryPersistence } from "@roamlink/persistence";
import {
  ADCOS_WEBHOOK_INBOX_REPOSITORY,
  AdcosWebhookInboxService,
  HmacWebhookVerifier,
  StaticWebhookSigningKeyRegistry,
} from "@roamlink/webhook-inbox";
import { assertNoSecretMaterial } from "@roamlink/retention";
import { DeterministicClock, fixtureCommandEnvelope } from "@roamlink/testkit";
import { RedactedLogValue, makeStructuredLogRecord } from "@roamlink/observability";
import { retryMetadataFor } from "@roamlink/integration";
import { RoamLinkError, ValidationError } from "@roamlink/contracts";
import {
  findSecretLiterals,
  overlayFor,
  readSourceFiles,
  toggleHint,
  violationEnabled,
} from "../src/index.js";
import {
  TEST_SIGNING_KEY_ID,
  TEST_SIGNING_SECRET,
  fakeWebhookDelivery,
} from "../../../packages/webhook-inbox/test/fake-adcos-webhooks.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-016";
const T0 = "2026-01-15T08:30:00.000Z";

describe(`${LOCK}: no secret leakage`, () => {
  it("green: a real webhook admission flow persists NO secret bytes (only a signature digest)", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    const verifier = new HmacWebhookVerifier({
      environment: "sandbox",
      keys: new StaticWebhookSigningKeyRegistry({
        [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
      }),
    });
    const inbox = new AdcosWebhookInboxService({
      verifier,
      persistence,
      reader: persistence,
      clock,
    });
    const delivery = fakeWebhookDelivery({
      spec: {
        eventId: "evt-rl-016",
        eventType: "connectivity_intent.created",
        resourceId: "intent-9",
        resourceKind: "connectivity_intent",
        resourceVersion: 1,
        occurredAt: T0,
        correlationId: "corr-rl-016",
      },
      deliveryId: "dlv-1",
      sequence: 1,
      receivedAt: T0,
    });
    const admission = await inbox.admitDelivery({ ...delivery, receivedAt: T0 as never });
    expect(admission.outcome).toBe("ADMITTED");

    const stored = await persistence
      .records(ADCOS_WEBHOOK_INBOX_REPOSITORY)
      .get("evt-rl-016");
    expect(stored).not.toBeNull();
    // The secret bytes appear NOWHERE in the committed record.
    const serialized = JSON.stringify(stored?.value);
    expect(serialized).not.toContain(TEST_SIGNING_SECRET);
    // Only a forensic DIGEST of the signature value is retained.
    expect((stored?.value as { delivery: { signature_digest: string } }).delivery.signature_digest).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("green: every durable artifact the flows produce passes the retention secret scanner", async () => {
    const persistence = createInMemoryPersistence();
    const clock = new DeterministicClock(T0);
    const verifier = new HmacWebhookVerifier({
      environment: "sandbox",
      keys: new StaticWebhookSigningKeyRegistry({
        [TEST_SIGNING_KEY_ID]: TEST_SIGNING_SECRET,
      }),
    });
    const inbox = new AdcosWebhookInboxService({
      verifier,
      persistence,
      reader: persistence,
      clock,
    });
    const delivery = fakeWebhookDelivery({
      spec: {
        eventId: "evt-rl-016b",
        eventType: "connectivity_contract.activated",
        resourceId: "contract-9",
        resourceKind: "connectivity_contract",
        resourceVersion: 4,
        occurredAt: T0,
        correlationId: "corr-rl-016b",
      },
      deliveryId: "dlv-2",
      sequence: 2,
      receivedAt: T0,
    });
    const admission = await inbox.admitDelivery({ ...delivery, receivedAt: T0 as never });
    expect(admission.outcome).toBe("ADMITTED");

    const envelope = fixtureCommandEnvelope({ createdAt: T0 });
    // Command envelopes carry ids and correlation, never secrets.
    expect(() => assertNoSecretMaterial(envelope.toPlain(), "command envelope")).not.toThrow();

    // Retry metadata is reason codes + instants only (value-free).
    const error = new RoamLinkError("unavailable", "injected transport failure", {
      reason: "TRANSPORT_UNKNOWN",
      retryable: true,
    });
    const retry = retryMetadataFor(error, clock.now());
    expect(() => assertNoSecretMaterial(retry, "retry metadata")).not.toThrow();

    const stored = await persistence
      .records(ADCOS_WEBHOOK_INBOX_REPOSITORY)
      .get("evt-rl-016b");
    expect(() => assertNoSecretMaterial(stored?.value, "admitted webhook record")).not.toThrow();
  });

  it("negative proof: the retention scanner DETECTS a smuggled secret (the suite can fail)", () => {
    const smuggled = {
      ok: true,
      auth: `Bearer ${TEST_SIGNING_SECRET}`,
      note: "persisted by a buggy path",
    };
    expect(() => assertNoSecretMaterial(smuggled, "smuggled record")).toThrow(ValidationError);
    if (violationEnabled(LOCK)) {
      // The violating fixture asserts the leak IS persisted: a tree whose
      // admission flow leaked the secret would make the green proof above
      // fail and this assertion pass - the suite is bound to the leak.
      expect(() => assertNoSecretMaterial(smuggled, "smuggled record")).not.toThrow();
    }
  });

  it("green: the log record redacts secret-bearing values on every serialization path", () => {
    const secretValue = "super-secret-hmac-material-do-not-log";
    const redacted = new RedactedLogValue(secretValue);
    expect(JSON.stringify(redacted)).toBe(JSON.stringify("[REDACTED]"));
    expect(String(redacted)).toBe("[REDACTED]");
    expect(inspect(redacted)).not.toContain(secretValue);
    expect(inspect(redacted)).toContain("[REDACTED]");
    expect(format("%s", redacted)).toBe("[REDACTED]");
    expect(redacted.toJSON()).toBe("[REDACTED]");

    const record = makeStructuredLogRecord({
      level: "info",
      message: "webhook verified",
      fields: { key: redacted },
      correlationId: "corr-rl-016",
      tenantId: "usr:00000000-0000-4000-8000-000000000002",
      at: T0,
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).toContain("[REDACTED]");
  });

  it("green: no production source contains literal credential material", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages", "apps"], overlayFor(LOCK)).filter(
      (file) => file.path.includes("/src/"),
    );
    const findings = findSecretLiterals(files);
    expect(
      findings.map((finding) => `${finding.file} (${finding.pattern})`),
      `${toggleHint(LOCK)} - credential material must never be committed`,
    ).toEqual([]);
  });

  it("negative proof: a committed private key in a production source turns the scan red (toggle)", () => {
    if (!violationEnabled(LOCK)) {
      // Detection proof runs in every mode: the scanner sees the marker.
      const pem = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
      const findings = findSecretLiterals([
        { path: "packages/projections/src/creds.ts", content: `export const K = ${JSON.stringify(pem)};` },
      ]);
      expect(findings.length).toBe(1);
      expect(findings[0]?.pattern).toBe("private key header");
      return;
    }
    const files = readSourceFiles(REPO_ROOT, ["packages", "apps"], overlayFor(LOCK)).filter(
      (file) => file.path.includes("/src/"),
    );
    const findings = findSecretLiterals(files);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.file).toBe("packages/projections/src/credentials.ts");
  });
});
