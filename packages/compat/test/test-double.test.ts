/**
 * The §10 test-double discipline (RL-036, spec/adcos-integration.md §10).
 *
 * The local ADCOS fake implements the SAME PUBLIC integration interface as
 * the real client and simulates duplicates, reordering, delayed events,
 * dropped events, transient failures and canonical-state changes. No test
 * depends on ADCOS internal implementation classes - proven here both at
 * the type level (the fake IS an AdcosClient) and at the source level (the
 * fake's imports are public RoamLink packages only).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AdcosApiError, type AdcosClient } from "@roamlink/adcos";
import { AdcosTransportError } from "@roamlink/integration";
import { parseUtcInstant } from "@roamlink/contracts";
import { FakeAdcos } from "../../integration/test/fake-adcos.js";
import { TEST_INTENT_REQUEST } from "../../reconciliation/test/helpers.js";

const FAKE_PATH = fileURLToPath(new URL("../../integration/test/fake-adcos.ts", import.meta.url));

async function createIntent(fake: FakeAdcos, key: string): Promise<string> {
  const document = await fake.createIntent(TEST_INTENT_REQUEST, { idempotencyKey: key as never });
  return (document as { id: string }).id;
}

describe("the local ADCOS fake implements the public interface (§10)", () => {
  it("IS an AdcosClient (type-level and runtime method presence)", () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const client: AdcosClient = fake; // compiles => public interface only
    for (const method of [
      "getApplication",
      "createIntent",
      "listIntents",
      "getIntent",
      "getIntentLifecycle",
      "acceptOffers",
      "activateContract",
      "listContracts",
      "getContract",
      "getContractUsage",
      "getContractAssurance",
      "terminateContract",
      "grantLease",
      "listLeases",
      "getLease",
      "renewLease",
      "revokeLease",
      "listWebhookEndpoints",
      "createWebhookEndpoint",
      "getWebhookEndpoint",
      "listWebhookEndpointDeliveries",
    ] as const) {
      expect(typeof client[method]).toBe("function");
    }
    expect(client.environment).toBe("sandbox");
    expect(client.apiVersion).toBe("2.0");
  });

  it("depends on NO ADCOS internals (public RoamLink imports only)", () => {
    const source = readFileSync(FAKE_PATH, "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    expect(imports.length).toBeGreaterThan(0);
    for (const imported of imports) {
      // Public @roamlink packages, node builtins, or the integration
      // boundary's own public export - never an ADCOS internal module.
      expect(
        imported.startsWith("@roamlink/") || imported.startsWith("node:") || imported.startsWith("../src/"),
        `the fake must not import ADCOS internals (found ${imported})`,
      ).toBe(true);
      expect(imported).not.toMatch(/@adcos\//);
      expect(imported).not.toMatch(/adcos\/(src|internal)/);
    }
  });
});

describe("the fake simulates the §10 failure/chaos modes", () => {
  it("DUPLICATES: the same event is deliverable multiple times", async () => {
    const fake = new FakeAdcos({ seedProbe: false, now: () => parseUtcInstant("2026-01-15T08:30:00.000Z") as never });
    await createIntent(fake, "idem-double-1");
    expect(fake.deliveries()).toHaveLength(1);
    fake.webhookDelivery = { ...fake.webhookDelivery, duplicateFactor: 3 };
    expect(fake.deliveries()).toHaveLength(3);
    expect(new Set(fake.deliveries().map((d) => d.event.event_id)).size).toBe(1);
  });

  it("REORDERING: deliveries can be reversed", async () => {
    const fake = new FakeAdcos({ seedProbe: false, now: () => parseUtcInstant("2026-01-15T08:30:00.000Z") as never });
    await createIntent(fake, "idem-reorder-1");
    await createIntent(fake, "idem-reorder-2");
    const inOrder = fake.deliveries().map((d) => d.event.event_id);
    expect(inOrder).toEqual(["evt-1", "evt-2"]);
    fake.webhookDelivery = { ...fake.webhookDelivery, reorder: "reverse" };
    expect(fake.deliveries().map((d) => d.event.event_id)).toEqual(["evt-2", "evt-1"]);
  });

  it("DELAYED EVENTS: deliveries are withheld until flushed", async () => {
    const fake = new FakeAdcos({ seedProbe: false, now: () => parseUtcInstant("2026-01-15T08:30:00.000Z") as never });
    fake.webhookDelivery = { ...fake.webhookDelivery, delayCount: 1 };
    await createIntent(fake, "idem-delay-1");
    await createIntent(fake, "idem-delay-2");
    expect(fake.deliveries()).toHaveLength(1); // the first event is withheld
    fake.flushDelayedDeliveries();
    expect(fake.deliveries()).toHaveLength(2); // and released on flush
  });

  it("DROPPED EVENTS: deliveries can be suppressed entirely", async () => {
    const fake = new FakeAdcos({ seedProbe: false, now: () => parseUtcInstant("2026-01-15T08:30:00.000Z") as never });
    await createIntent(fake, "idem-drop-1");
    await createIntent(fake, "idem-drop-2");
    fake.webhookDelivery = { ...fake.webhookDelivery, dropCount: 1 };
    expect(fake.deliveries()).toHaveLength(1);
    expect(fake.deliveries()[0]?.event.event_id).toBe("evt-2"); // evt-1 was dropped
    expect(fake.emittedEvents()).toHaveLength(2); // the source truth is still visible
  });

  it("TRANSIENT FAILURES: injectable ADCOS errors and transport failures", async () => {
    const fake = new FakeAdcos({ seedProbe: false });
    const intentId = await createIntent(fake, "idem-transient-1");
    fake.failNext({ kind: "adcos-error", code: "rate-limited" }, { count: 2 });
    await expect(fake.getIntent(intentId)).rejects.toThrow(AdcosApiError);
    await expect(fake.getIntent(intentId)).rejects.toMatchObject({ code: "rate-limited" });

    fake.failNext({ kind: "transport", outcome: "unknown" }, { count: 1 });
    await expect(fake.getIntent(intentId)).rejects.toThrow(AdcosTransportError);
    await expect(fake.getIntent(intentId)).resolves.toBeDefined(); // transient only
  });

  it("CANONICAL-STATE CHANGES: silent mutations with no event, and removals", async () => {
    const fake = new FakeAdcos({ seedProbe: false, now: () => parseUtcInstant("2026-01-15T08:30:00.000Z") as never });
    const intentId = await createIntent(fake, "idem-silent-1");
    const document = await fake.acceptOffers(
      intentId,
      { offers: [{ offer: "o1" }], recorded_at: parseUtcInstant("2026-01-15T08:30:00.000Z") },
      { idempotencyKey: "idem-silent-offers" as never },
    );
    const contractId = (document as { id: string }).id;
    const eventsBefore = fake.emittedEvents().length;

    fake.silentStateChange(contractId, "CONTRACT_ACTIVE");
    expect(fake.emittedEvents().length).toBe(eventsBefore); // NO event emitted
    const contract = await fake.getContract(contractId);
    expect((contract as Record<string, unknown>)["state"]).toBe("CONTRACT_ACTIVE");
    expect((contract as Record<string, unknown>)["resource_version"]).toBe(2);

    fake.forgetResource("connectivity_contract", contractId);
    await expect(fake.getContract(contractId)).rejects.toMatchObject({ code: "resource-unknown" });
  });
});
