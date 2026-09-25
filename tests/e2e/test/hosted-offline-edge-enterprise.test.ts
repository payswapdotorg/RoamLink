/**
 * RL-113 — the hosted user-journey E2E suite, part 4:
 * the offline-edge journey (the apps/mobile mobileDocument legs — Now /
 * Capabilities / Controls / Outbox) and the enterprise-onboarding journey.
 *
 * The offline-edge journey is device-side by nature: the edge continues
 * observation and desired-state work while the host is unreachable, and
 * renders its own honest surfaces. The suite drives the REAL edge engine
 * (packages/edge + edge-actions) through the real MobileEdgeShell and
 * asserts the four mobile legs over real outbox state — queued is NOT
 * executed, observation continues offline, freshness is always rendered.
 *
 * The enterprise-onboarding journey is pinned honestly: the real hosted
 * runtime does not compose the /v1/enterprise/workspace read (it answers
 * the plain 404 NOT_FOUND — not even the typed read-model refusal), so the
 * customer surface fails closed. That gap is recorded here as an explicit
 * finding (never a silently-passing assertion).
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createAesGcmEdgePayloadCipher } from "@roamlink/edge";
import { InMemoryPlatformActionExecutor } from "@roamlink/edge-actions";
import { fragment } from "@roamlink/app-kit";
import {
  InMemoryMobilePlatformProbe,
  MobileEdgeShell,
  actionOutcomeScreen,
  capabilityMatrixScreen,
  connectivityScreen,
  mobileDocument,
  outboxScreen,
} from "@roamlink/mobile";
import { deterministicUuidFromSeed, fixtureTenantId } from "@roamlink/testkit";

import { bootHostedJourney } from "../src/host.js";

const T = "2026-03-01T08:00:00.000Z";
const KEY_BYTES = new Uint8Array(32).fill(23);
const SIGNING_KEY = "e2e-mobile-enrollment-key";

/** The online observation batch (capability + context evidence). */
const ONLINE_BATCH = [
  { kind: "capability-probe", capability: "wifi_control", status: "available" },
  { kind: "capability-probe", capability: "wifi_observation", status: "available" },
  { kind: "context-observation", contextField: "connectivity-state", value: "online" },
] as const;

function makeSigner(key: string) {
  return {
    algorithm: "hmac-sha256" as const,
    keyId: "e2e-enrollment",
    async sign(message: string): Promise<string> {
      return createHmac("sha256", key).update(message, "utf8").digest("hex");
    },
    async verify(message: string, signature: string): Promise<boolean> {
      return createHmac("sha256", key).update(message, "utf8").digest("hex") === signature;
    },
  };
}

function buildEdgeShell(): MobileEdgeShell {
  const probe = new InMemoryMobilePlatformProbe({
    batches: [
      [...ONLINE_BATCH].map((sample) => ({
        observedAt: T,
        evidence: { kind: "platform-api-probe", source: "E2EProbe" },
        subject: sample,
      })),
    ],
  });
  let counter = 0;
  const uuid = (seed: number): string => deterministicUuidFromSeed(seed + (++counter));
  return new MobileEdgeShell({
    deviceRef: "device-e2e-edge",
    platform: { family: "ios", platformVersion: "18.2" },
    actorId: "actor-e2e-edge",
    tenantId: fixtureTenantId(),
    probe,
    executor: new InMemoryPlatformActionExecutor(),
    cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
    outboxKeyId: "e2e-outbox-key",
    observationIdGenerator: () => uuid(1),
    snapshotIdGenerator: () => uuid(10_000),
    outboxRecordIdGenerator: () => uuid(20_000),
    actionIdGenerator: () => uuid(30_000),
    commandIdGenerator: () => uuid(40_000),
    correlationIdGenerator: () => `corr-e2e-edge-${++counter}`,
    idempotencyKeyGenerator: () => `idem-e2e-edge-${++counter}`,
    desiredStateIdGenerator: () => uuid(50_000),
    publicationIdGenerator: () => uuid(60_000),
    signer: makeSigner(SIGNING_KEY),
    snapshotFreshnessMs: 60_000,
  });
}

describe("RL-113 hosted journey: offline edge (the mobile document legs)", () => {
  it("renders Now / Capabilities / Controls / Outbox honestly while offline", async () => {
    const shell = buildEdgeShell();

    // Enrollment: the signed, versioned, expiring capability publication.
    // The snapshot chain is versioned per capability observation, so the
    // journey-shaped assertions are: signed + versioned (>= 1) and the
    // chain ADVANCES on re-enrollment (never mutated in place).
    const publication = await shell.enroll(T);
    expect(publication.snapshot.sequence).toBeGreaterThanOrEqual(1);
    const second = await shell.enroll(T);
    expect(second.snapshot.sequence).toBeGreaterThan(publication.snapshot.sequence);
    expect(second.snapshotDigest).not.toBe(publication.snapshotDigest);

    // The device goes offline; observation and desired-state continue.
    shell.enterOffline(T);
    await shell.runObservationCycle(T);
    expect(shell.isSyncReachable()).toBe(false);

    // A desired action is QUEUED into the encrypted outbox — queued is not
    // executed (the authoritative result arrives through sync).
    const queued = await shell.requestAction(
      { capability: "wifi_control", parameters: { ssid: "Acahat-Guest" } },
      "server",
      T,
    );
    expect(queued.mode).toBe("server");
    expect(queued.outcome).toBe("QUEUED");

    // The four mobile legs over the real edge state, wrapped in the real
    // mobile document shell (Now / Capabilities / Controls / Outbox).
    const view = await shell.connectivityView(T);
    const records = await shell.outboxRecords();
    const document = mobileDocument(
      "Offline edge journey",
      fragment(
        connectivityScreen(view),
        capabilityMatrixScreen(shell.capabilityMatrix(T)),
        actionOutcomeScreen(queued, "wifi_control"),
        outboxScreen(records),
      ),
    );

    // The mobile navigation (the four legs) is part of the document shell.
    for (const legLabel of ["Now", "Capabilities", "Controls", "Outbox"]) {
      expect(document).toContain(`>${legLabel}</a>`);
    }

    // Leg 1 — Now: the honest offline banner and last-known connectivity.
    expect(document).toContain("Connectivity now");
    expect(document).toContain(
      "Offline - observation continues; queued commands are held in the encrypted outbox",
    );
    // "online" is rendered as a <strong> value next to the label.
    expect(document).toContain("Connectivity (last observed):");
    expect(document).toContain(">online</strong>");
    expect(document).toContain('data-freshness="FRESH"');
    expect(document).toContain("Outbox: 1 pending, 0 synced, 0 dead-lettered");

    // Leg 2 — Capabilities: the evidence-based truth table with the gate.
    expect(document).toContain("Capabilities");
    expect(document).toContain("wifi_control");
    expect(document).toContain('data-state="available"');
    expect(document).toContain("allow");
    expect(document).toContain("Evidence-based: controls only unlock with real platform evidence.");

    // Leg 3 — Controls: the queued outcome with the queued != executed law.
    expect(document).toContain("Controls");
    expect(document).toContain("Server-bound desired state");
    expect(document).toContain(
      "Queued into the encrypted offline outbox - queued is NOT executed; the authoritative result arrives through sync.",
    );

    // Leg 4 — Outbox: the encrypted outbox's honest boundary state.
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("pending");
    expect(document).toContain("Encrypted offline outbox");
    expect(document).toContain('data-state="pending"');
    expect(document).toContain("Payloads are ciphertext-only at rest; identity/dedupe metadata stays in the clear.");
  });
});

describe("RL-113 hosted journey: enterprise onboarding (explicit known gap)", () => {
  it("fails the workspace read closed and records the gap honestly (never a fabricated journey state)", async () => {
    const journey = await bootHostedJourney({ seed: 0x0d1, email: "enterprise@example.com" });
    try {
      // KNOWN GAP (RL-113 finding, recorded — never silently passed): the
      // real hosted runtime does not compose the enterprise workspace read.
      // The app-contract route /v1/enterprise/workspace is not in the
      // real API's read-model refusal set either, so the raw answer is the
      // plain 404 NOT_FOUND (no existence oracle, no invented workspace).
      let error: unknown;
      try {
        await journey.app.client().getEnterpriseWorkspace();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ kind: "not-found", reason: "NOT_FOUND", status: 404 });

      // The customer surface fails closed: the shell renders (entry point +
      // navigation; the composed connectivity read states the honest
      // no-reference state — PA-019), the workspace body is the typed error
      // panel (its read set includes the enterprise workspace read, which
      // answers the plain 404 — the recorded gap), and NO enterprise
      // journey state (workspace -> verification -> policy -> connector ->
      // devices -> capabilities -> goal -> overview) is fabricated anywhere.
      const html = await journey.app.renderDocument({ page: "workspace" });
      expect(html).toContain('data-shell-connectivity="no-reference"');
      expect(html).toContain('data-mutation-result="error"');
      expect(html).not.toContain('data-workspace');
      expect(html).not.toContain("organization verification");
      // The More destination (the workspace's mobile discovery path) stays
      // discoverable.
      expect(html).toContain('href="/more"');
    } finally {
      await journey.dispose();
    }
  });
});
