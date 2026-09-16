import { describe, expect, it } from "vitest";
import { canonicalizeJson, parseUtcInstant } from "@roamlink/contracts";
import type { UtcInstant } from "@roamlink/contracts";
import { DeterministicClock, DeterministicUuidGenerator, fixtureTenantId } from "@roamlink/testkit";
import { AdcosApiError, parseAdcosSignatureRef } from "@roamlink/adcos";
import {
  ADCOS_V2_SURFACE_SUPPORT,
  AdcosCompatibilityState,
  AdcosOfferReservationAdapter,
  mapAdcosFailure,
  runAdcosCompatibilityCheck,
  type AdcosCommandContext,
} from "../src/index.js";
import { FakeAdcos } from "./fake-adcos.js";

const T0 = parseUtcInstant("2026-01-15T08:30:00.000Z");
const at = (iso: string): UtcInstant => parseUtcInstant(iso);

function makeAdapter(fake: FakeAdcos) {
  const adapter = new AdcosOfferReservationAdapter({
    client: fake,
    clock: new DeterministicClock(T0),
    commandIds: new DeterministicUuidGenerator(100),
    compatibility: new AdcosCompatibilityState(),
  });
  return adapter;
}

function commandContext(): AdcosCommandContext {
  return {
    actorId: "actor-77",
    tenantId: fixtureTenantId({ seed: 9 }),
    intentVersion: 4,
  };
}

/** Runs the startup compatibility gate through the adapter's own state. */
async function runGate(fake: FakeAdcos, adapter: AdcosOfferReservationAdapter): Promise<void> {
  await runAdcosCompatibilityCheck(adapter.client, adapter.compatibility, {
    ...(fake.probeRefs !== null ? { probe: fake.probeRefs } : {}),
    at: T0,
  });
}

describe("typed unsupported degradation (RL-032, §3 no undocumented endpoints)", () => {
  it("discoverOffers rejects with the closed route-unknown code", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await expect(adapter.discoverOffers()).rejects.toMatchObject({
      code: "route-unknown",
    });
    // the surface support descriptor agrees
    expect(ADCOS_V2_SURFACE_SUPPORT.offersDiscovery).toBe(false);
  });

  it("readBillingCommercialReference rejects with the closed route-unknown code", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await expect(adapter.readBillingCommercialReference()).rejects.toMatchObject({
      code: "route-unknown",
    });
    expect(ADCOS_V2_SURFACE_SUPPORT.billingCommercialReferenceReads).toBe(false);
  });

  it("unsupported degradation adapts onto the RoamLink domain kind (no parallel kinds)", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    const error = await adapter.discoverOffers().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdcosApiError);
    const mapped = mapAdcosFailure(error);
    expect(mapped.kind).toBe("domain");
    expect(mapped.reason).toBe("ADCOS_ROUTE_UNKNOWN");
    expect(mapped.retryable).toBe(false);
    // The message explains the degradation without echoing values.
    expect(mapped.message).toContain("v2 public surface does not expose");
  });

  it("the unsupported methods never touch the client (no undocumented calls)", async () => {
    const fake = new FakeAdcos();
    const before = fake.emittedEvents().length;
    await expect(makeAdapter(fake).discoverOffers()).rejects.toBeInstanceOf(AdcosApiError);
    await expect(makeAdapter(fake).readBillingCommercialReference()).rejects.toBeInstanceOf(AdcosApiError);
    expect(fake.emittedEvents().length).toBe(before);
  });
});

async function freshIntentId(fake: FakeAdcos): Promise<string> {
  const document = await fake.createIntent(
    {
      requirements: [{ dimension: "usage", classification: "soft", statement: { profile: "test" } }],
      validity: { start: T0, end: at("2026-01-16T08:30:00.000Z") },
      termination: { actor: "customer", on_expiry: "release" },
      recorded_at: T0,
    },
    { idempotencyKey: `idem.test.fresh-intent.${fake.intentCount() + 1}` as never },
  );
  return (document as Record<string, unknown>)["id"] as string;
}

describe("offer/contract command surface (RL-032)", () => {
  it("selectOffers creates the ADCOS contract with a full §5 envelope", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await runGate(fake, adapter);
    const intentId = await freshIntentId(fake);
    const result = await adapter.selectOffers(
      intentId,
      { offers: [{ offer: "offer-1" }], recorded_at: T0 },
      commandContext(),
    );
    const document = result.document as Record<string, unknown>;
    expect(document["intent_id"]).toBe(intentId);
    expect(document["state"]).toBe("OFFER_SELECTED");
    // §5 envelope completeness
    const plain = result.envelope.toPlain();
    expect(plain.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plain.correlationId).toMatch(/^corr\.offers_accept\./);
    expect(plain.idempotencyKey).toMatch(/^idem\.offers_accept\./);
    expect(plain.actorId).toBe("actor-77");
    expect(plain.tenantId).toBe(fixtureTenantId({ seed: 9 }));
    expect(plain.intentVersion).toBe(4);
    expect(plain.createdAt).toBe(T0);
    expect(plain.retry.attempt).toBe(1);
  });

  it("activateContract and terminateContract run the lifecycle through the seam", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await runGate(fake, adapter);
    const intentId = await freshIntentId(fake);
    const contract = await adapter.selectOffers(
      intentId,
      { offers: [{ offer: "offer-2" }], recorded_at: T0 },
      commandContext(),
    );
    const contractId = (contract.document as Record<string, unknown>)["id"] as string;
    const activated = await adapter.activateContract(
      intentId,
      { activated_at: at("2026-01-15T09:00:00.000Z"), signature_refs: [parseAdcosSignatureRef("sig-1")] },
      commandContext(),
    );
    expect((activated.document as Record<string, unknown>)["state"]).toBe("CONTRACT_ACTIVE");
    const terminated = await adapter.terminateContract(
      contractId,
      { condition: "customer-request", recorded_reason: "travel ended", instant: at("2026-01-20T09:00:00.000Z") },
      commandContext(),
    );
    expect((terminated.document as Record<string, unknown>)["state"]).toBe("TERMINATED");
  });

  it("invalid lifecycle transitions surface as mapped validation errors, never silent rewrites", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await runGate(fake, adapter);
    const intentId = await freshIntentId(fake);
    const contract = await adapter.selectOffers(
      intentId,
      { offers: [{ offer: "offer-3" }], recorded_at: T0 },
      commandContext(),
    );
    const contractId = (contract.document as Record<string, unknown>)["id"] as string;
    // terminating an already-terminated contract is an illegal v2 transition
    await adapter.terminateContract(
      contractId,
      { condition: "customer-request", recorded_reason: "first", instant: at("2026-01-20T09:00:00.000Z") },
      commandContext(),
    );
    await expect(
      adapter.terminateContract(
        contractId,
        { condition: "customer-request", recorded_reason: "again", instant: at("2026-01-21T09:00:00.000Z") },
        commandContext(),
      ),
    ).rejects.toMatchObject({ kind: "validation", reason: "ADCOS_INVALID_INPUT" });
  });
});

describe("reservation surface over the v2 lease routes (RL-032)", () => {
  it("createReservation grants a lease; readReservation/listReservations read it back", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await runGate(fake, adapter);
    const probe = fake.probeRefs as { intentId: string; contractId: string; leaseId: string };
    const created = await adapter.createReservation(
      probe.contractId,
      { granted_at: at("2026-01-15T10:00:00.000Z") },
      commandContext(),
    );
    const leaseId = (created.document as Record<string, unknown>)["id"] as string;
    expect((created.document as Record<string, unknown>)["status"]).toBe("granted");

    const read = await adapter.readReservation(leaseId);
    expect((read as Record<string, unknown>)["id"]).toBe(leaseId);
    const leases = await adapter.listReservations();
    expect(leases.items.length).toBeGreaterThanOrEqual(2); // probe lease + created
  });

  it("renewReservation and revokeReservation advance the lease lifecycle", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await runGate(fake, adapter);
    const probe = fake.probeRefs as { intentId: string; contractId: string; leaseId: string };
    const renewed = await adapter.renewReservation(
      probe.leaseId,
      { granted_at: at("2026-01-16T10:00:00.000Z") },
      commandContext(),
    );
    expect((renewed.document as Record<string, unknown>)["status"]).toBe("renewed");
    const revoked = await adapter.revokeReservation(
      probe.leaseId,
      { reason: "no-longer-needed" },
      commandContext(),
    );
    expect((revoked.document as Record<string, unknown>)["status"]).toBe("revoked");
    await expect(
      adapter.renewReservation(probe.leaseId, { granted_at: at("2026-01-17T10:00:00.000Z") }, commandContext()),
    ).rejects.toMatchObject({ kind: "validation", reason: "ADCOS_INVALID_INPUT" });
  });

  it("duplicate delivery of the same reservation command is absorbed (deterministic key)", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await runGate(fake, adapter);
    const probe = fake.probeRefs as { intentId: string; contractId: string; leaseId: string };
    const before = fake.leaseCount();
    const request = { granted_at: at("2026-01-15T11:00:00.000Z") };
    const first = await adapter.createReservation(probe.contractId, request, commandContext());
    // A "duplicate delivery": same payload, same subject, derived key identical
    // even though the adapter generates a fresh command id per call.
    const second = await adapter.createReservation(probe.contractId, request, commandContext());
    expect(fake.leaseCount()).toBe(before + 1);
    expect(canonicalizeJson(second.document)).toBe(canonicalizeJson(first.document));
    expect(second.envelope.idempotencyKey).toBe(first.envelope.idempotencyKey);
    expect(second.envelope.commandId).not.toBe(first.envelope.commandId);
  });

  it("retry after a timeout: the derived key replays the same lease (post fault)", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await runGate(fake, adapter);
    const probe = fake.probeRefs as { intentId: string; contractId: string; leaseId: string };
    const before = fake.leaseCount();
    const request = { granted_at: at("2026-01-15T12:00:00.000Z") };
    fake.failNext({ kind: "transport", outcome: "unknown" }, { phase: "post" });
    const error = await adapter
      .createReservation(probe.contractId, request, commandContext())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "unknown-state", reason: "ADCOS_TIMEOUT_OUTCOME_UNKNOWN" });
    expect(fake.leaseCount()).toBe(before + 1); // applied, response lost
    // retry: same deterministic key -> replay, no second lease
    const retried = await adapter.createReservation(probe.contractId, request, commandContext());
    expect(fake.leaseCount()).toBe(before + 1);
    expect((retried.document as Record<string, unknown>)["status"]).toBe("granted");
  });
});

describe("reads surface (RL-032)", () => {
  it("usage, assurance, lifecycle and contract reads return the opaque documents", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    const probe = fake.probeRefs as { intentId: string; contractId: string; leaseId: string };
    const usage = await adapter.readContractUsage(probe.contractId);
    expect((usage as Record<string, unknown>)["contract_id"]).toBe(probe.contractId);
    const assurance = await adapter.readContractAssurance(probe.contractId);
    expect((assurance as Record<string, unknown>)["contract_id"]).toBe(probe.contractId);
    const lifecycle = await adapter.readIntentLifecycle(probe.intentId);
    expect((lifecycle as Record<string, unknown>)["intent_id"]).toBe(probe.intentId);
    const contract = await adapter.getContract(probe.contractId);
    expect((contract as Record<string, unknown>)["id"]).toBe(probe.contractId);
    const contracts = await adapter.listContracts();
    expect(contracts.items.length).toBeGreaterThanOrEqual(1);
  });

  it("unknown resources map onto the not-found kind", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    await expect(adapter.getContract("contract-nope")).rejects.toMatchObject({
      kind: "not-found",
      reason: "ADCOS_RESOURCE_UNKNOWN",
    });
    await expect(adapter.readReservation("lease-nope")).rejects.toMatchObject({
      kind: "not-found",
      reason: "ADCOS_RESOURCE_UNKNOWN",
    });
  });

  it("mutations fail closed before the gate passes (§9)", async () => {
    const fake = new FakeAdcos();
    const adapter = makeAdapter(fake);
    const probe = fake.probeRefs as { intentId: string; contractId: string; leaseId: string };
    await expect(
      adapter.selectOffers(probe.intentId, { offers: [], recorded_at: T0 }, commandContext()),
    ).rejects.toMatchObject({ kind: "domain", reason: "ADCOS_COMPATIBILITY_GATE_UNVERIFIED" });
    expect(fake.contractCount()).toBe(1); // only the probe contract
  });
});
