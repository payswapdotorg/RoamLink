/**
 * RL-115 — the capability-discoverability cross-reference suite (mobile/edge
 * surface).
 *
 * The web-side suite (apps/web/test/rl115-capability-discoverability.test.ts)
 * marks several inventory rows VERIFIED(proxy) because their ONLY truthful
 * surface is the MOBILE edge shell. This file is the render-level proof for
 * those rows, over the REAL shell + views:
 *
 *  - CAP-C-OFFLINE-OUTBOX: the encrypted outbox screen (queued != executed),
 *  - CAP-X-WIFI / CAP-X-ESIM-MANAGE: the capability truth table renders
 *    platform-reported rows (wifi_control available; esim_profile_install
 *    requires-permission) with status, evidence class, freshness and the
 *    gate preview — and the eSIM row's management GAP is pinned (status +
 *    guidance only, no install/remove/enable flow),
 *  - the manual-guidance recovery map covers the closed deny/degrade reasons
 *    (the §7 recovery path for gated capabilities).
 *
 * Findings are recorded, not fixed (threat-model-verification.md precedent).
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { deterministicUuidFromSeed, fixtureTenantId } from "@roamlink/testkit";
import { createAesGcmEdgePayloadCipher } from "@roamlink/edge";
import { InMemoryPlatformActionExecutor } from "@roamlink/edge-actions";

import { MobileEdgeShell, type MobileConnectivityView } from "../src/shell.js";
import { InMemoryMobilePlatformProbe } from "../src/platform-probe.js";
import { capabilityMatrixScreen, connectivityScreen, manualGuidanceFor, mobileDocument, outboxScreen } from "../src/views.js";

const T0 = "2026-03-01T08:00:00.000Z";
const KEY_BYTES = new Uint8Array(32).fill(31);
const SIGNING_KEY = "rl115-views-test-key";

function buildShell(): MobileEdgeShell {
  const probe = new InMemoryMobilePlatformProbe({
    batches: [
      [
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: { kind: "capability-probe", capability: "wifi_control", status: "available" },
        },
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: {
            kind: "capability-probe",
            capability: "esim_profile_install",
            status: "requires-permission",
          },
        },
        {
          observedAt: T0,
          evidence: { kind: "platform-api-probe", source: "TestProbe" },
          subject: { kind: "context-observation", contextField: "connectivity-state", value: "online" },
        },
      ],
    ],
  });
  let counter = 0;
  return new MobileEdgeShell({
    deviceRef: "device-7f3a",
    platform: { family: "ios", platformVersion: "18.2" },
    actorId: "actor-1",
    tenantId: fixtureTenantId(),
    probe,
    executor: new InMemoryPlatformActionExecutor(),
    cipher: createAesGcmEdgePayloadCipher(async () => KEY_BYTES),
    outboxKeyId: "edge-outbox-key",
    observationIdGenerator: () => deterministicUuidFromSeed(++counter),
    snapshotIdGenerator: () => deterministicUuidFromSeed(10_000 + counter),
    outboxRecordIdGenerator: () => deterministicUuidFromSeed(20_000 + counter),
    actionIdGenerator: () => deterministicUuidFromSeed(30_000 + counter),
    commandIdGenerator: () => deterministicUuidFromSeed(40_000 + counter),
    correlationIdGenerator: () => `corr-${counter}`,
    idempotencyKeyGenerator: () => `idem-${counter}`,
    desiredStateIdGenerator: () => deterministicUuidFromSeed(50_000 + counter),
    publicationIdGenerator: () => deterministicUuidFromSeed(60_000 + counter),
    signer: {
      algorithm: "hmac-sha256",
      keyId: "enrollment-rl115",
      async sign(message: string): Promise<string> {
        return createHmac("sha256", SIGNING_KEY).update(message, "utf8").digest("hex");
      },
      async verify(): Promise<boolean> {
        return true;
      },
    },
    snapshotFreshnessMs: 60_000,
  });
}

describe("RL-115 the mobile capability truth table (CAP-X-WIFI / CAP-X-ESIM-MANAGE proxies)", () => {
  it("renders platform-reported capability rows with status, evidence, freshness and gate preview", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    const rows = shell.capabilityMatrix(T0);
    const html = capabilityMatrixScreen(rows).html;

    // CAP-X-WIFI: the available capability renders with its gate preview.
    const wifi = rows.find((row) => row.capability === "wifi_control");
    expect(wifi?.gatePreview.admission).toBe("ADMITTED");
    expect(html).toContain("wifi_control");
    expect(html).toContain("allow");

    // The requires-permission capability renders its closed gate reason.
    const esim = rows.find((row) => row.capability === "esim_profile_install");
    expect(esim?.gatePreview.admission).toBe("BLOCKED-DEGRADED");
    expect(html).toContain("esim_profile_install");
    expect(html).toContain("capability-requires-permission");

    // Every row's freshness is rendered (text + badge), never color alone.
    expect(html).toMatch(/data-freshness="(FRESH|STALE|UNKNOWN)"/);
  });

  it("GAP CAP-X-ESIM-MANAGE (RL-115-F1, pinned): the eSIM rows are STATUS-ONLY — the matrix offers no management affordance", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    const rows = shell.capabilityMatrix(T0);
    const matrixHtml = capabilityMatrixScreen(rows).html;
    const nowHtml = connectivityScreen(await shell.connectivityView(T0)).html;

    // What EXISTS: the full closed eSIM vocabulary renders as capability rows
    // (install probed requires-permission; remove/enable untouched -> UNKNOWN)
    // plus the closed guidance text for the blocked gate.
    expect(matrixHtml).toContain("esim_profile_install");
    expect(matrixHtml).toContain("esim_profile_remove");
    expect(matrixHtml).toContain("esim_profile_enable");
    expect(manualGuidanceFor("capability-requires-permission", "esim_profile_install")).toContain(
      "permission",
    );

    // What DOES NOT exist (the pinned GAP): no management affordance of any
    // kind. The truth table is STATUS-ONLY — no anchor, no form, no button:
    // a customer cannot act on install/remove/enable from the surface, there
    // is no profile inventory view and no activation-code entry anywhere.
    expect(matrixHtml, "no action anchors on the matrix").not.toContain("<a ");
    expect(matrixHtml, "no forms on the matrix").not.toContain("<form");
    expect(matrixHtml, "no buttons on the matrix").not.toContain("<button");
    const joined = `${matrixHtml}\n${nowHtml}`.toLowerCase();
    expect(joined).not.toContain("activation code");
    expect(joined).not.toContain("profile list");
  });
});

describe("RL-115 the mobile outbox surface (CAP-C-OFFLINE-OUTBOX)", () => {
  it("renders the encrypted outbox with the honest queued != executed boundary", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    await shell.requestAction({ capability: "wifi_control" }, "server", T0);
    const records = await shell.outboxRecords();
    const html = mobileDocument("Outbox", outboxScreen(records));
    expect(html).toContain("Encrypted offline outbox");
    expect(html).toContain("ciphertext-only");
    expect(html).toContain("pending"); // the record's boundary state, as text
    expect(html).toMatch(/data-state="pending"/i);
  });

  it("the Now screen names the outbox counts and the offline boundary honestly", async () => {
    const shell = buildShell();
    await shell.runObservationCycle(T0);
    const view: MobileConnectivityView = await shell.connectivityView(T0);
    const html = connectivityScreen(view).html;
    expect(html).toContain("Outbox:");
    expect(html).toContain("pending");
    expect(html).toContain("Sync: reachable (queued commands will converge)");
  });
});

describe("RL-115 the §7 recovery path: the closed manual-guidance map", () => {
  it("covers every deny/degrade reason with actionable manual guidance", () => {
    for (const reason of [
      "capability-requires-permission",
      "capability-unavailable",
      "capability-unknown",
      "evidence-class-insufficient",
      "evidence-stale",
      "action-unsupported",
    ]) {
      const guidance = manualGuidanceFor(reason, "wifi_control");
      expect(guidance.length, reason).toBeGreaterThan(10);
      // Guidance is actionable (names the platform escape) for the two
      // platform-bound reasons.
      if (reason === "capability-requires-permission" || reason === "capability-unavailable") {
        expect(guidance).toMatch(/platform|settings/i);
      }
    }
  });
});
