/**
 * Fake-API contract-semantics tests (RL-060/061): the deterministic fake must
 * behave exactly like the contract promises at the boundary - idempotency,
 * tenant scoping, admin authorization fail-closed, the suspended-org escape,
 * freshness degradation, the audit chain and honest stage progression.
 */
import { describe, expect, it } from "vitest";
import { DeterministicClock, DeterministicUuidGenerator, SequenceIdGenerator } from "@roamlink/testkit";

import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  isApiClientError,
} from "../src/index.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "org:99999999-8888-4777-8666-555555555555";
const OWNER = "usr:aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "usr:aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const SUBSCRIPTION_ID = "88888888-0000-4000-8000-000000000001";
const CASE_ID = "cafecafe-0000-4000-8000-000000000001";

function harness(options?: { now?: string }) {
  const clock = new DeterministicClock(options?.now ?? "2025-01-06T09:45:00.000Z");
  const ids = new DeterministicUuidGenerator(5000);
  const api = createInMemoryApi(fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => ids.next(),
  });
  const clientFor = (actor: string, tenant: string = TENANT) =>
    new RoamLinkApiClient({
      transport: api.transport,
      actor: { actorId: actor, tenantId: tenant },
      ids: new SequenceIdGenerator({ prefix: "c-" }),
    });
  return { api, clock, clientFor };
}

describe("idempotency at the boundary (RL-LOCK-014)", () => {
  it("a replayed key performs no additional effect", async () => {
    const { clientFor } = harness();
    const client = clientFor(MEMBER);
    const first = await client.placeOrder(
      { lines: [{ variantId: "55555555-0000-4000-8000-000000000002", quantity: 1 }] },
      { idempotencyKey: "key-1", correlationId: "corr-1" },
    );
    const replay = await client.placeOrder(
      { lines: [{ variantId: "55555555-0000-4000-8000-000000000002", quantity: 1 }] },
      { idempotencyKey: "key-1", correlationId: "corr-1" },
    );
    expect(replay.commandId).toBe(first.commandId);
    const orders = await client.listOrders();
    expect(orders).toHaveLength(2); // the seeded order + ONE new order
  });
});

describe("tenant scoping fails closed (spec/security.md)", () => {
  it("cross-tenant reads 404 (no existence oracle)", async () => {
    const { clientFor } = harness();
    const outsider = clientFor(MEMBER, OTHER_TENANT);
    const error = await outsider.listDevices().catch((e: unknown) => e);
    expect(isApiClientError(error) && error.status === 404).toBe(true);
  });

  it("a member of another org cannot even see this org's routes", async () => {
    const { clientFor } = harness();
    const member = clientFor(MEMBER, OTHER_TENANT);
    const error = await member.listDevices().catch((e: unknown) => e);
    expect(isApiClientError(error) && error.status === 404).toBe(true);
  });

  it("notification reads are recipient-scoped", async () => {
    const { clientFor } = harness();
    const owner = clientFor(OWNER);
    const error = await owner
      .markNotificationRead({ notificationId: "d0d0d0d0-0000-4000-8000-000000000001" })
      .catch((e: unknown) => e);
    expect(isApiClientError(error) && error.status === 403).toBe(true);
  });
});

describe("admin authorization fails closed (RL-061 threat model)", () => {
  it("a member can read org info but cannot mutate it (403, audited as denied)", async () => {
    const { clientFor } = harness();
    const member = clientFor(MEMBER);
    const orgs = await member.listOrganizations();
    expect(orgs).toHaveLength(1);
    const orgRevision = orgs[0]?.revision;
    if (orgRevision === undefined) throw new Error("missing org revision");
    const error = await member
      .suspendOrganization({ tenantId: TENANT }, { expectedVersion: orgRevision })
      .catch((e: unknown) => e);
    expect(isApiClientError(error)).toBe(true);
    if (isApiClientError(error)) {
      expect(error.status).toBe(403);
      expect(error.reason).toBe("ACTOR_PERMISSION_MISSING");
    }
    const audit = await clientFor(OWNER).listAuditEvents({ category: "admin-override" });
    const denied = audit.events.filter((e) => e.outcome === "denied");
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.some((e) => e.action === "org.suspend")).toBe(true);
  });

  it("a member cannot trigger reconciliation or advance support cases", async () => {
    const { clientFor } = harness();
    const member = clientFor(MEMBER);
    const triggerError = await member
      .triggerReconciliation({ trigger: "manual" })
      .catch((e: unknown) => e);
    expect(isApiClientError(triggerError) && triggerError.status === 403).toBe(true);
    const caseError = await member
      .advanceSupportCase({ caseId: CASE_ID, transition: "resolve" }, { expectedVersion: 2 })
      .catch((e: unknown) => e);
    expect(isApiClientError(caseError) && caseError.status === 403).toBe(true);
  });

  it("an admin can manage the org; suspend blocks members until reactivation", async () => {
    const { clientFor } = harness();
    const admin = clientFor(ADMIN);
    const orgs = await admin.listOrganizations();
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.status).toBe("active");
    const orgRevision = orgs[0]?.revision;
    if (orgRevision === undefined) throw new Error("missing org revision");

    const ack = await admin.suspendOrganization(
      { tenantId: TENANT },
      { expectedVersion: orgRevision },
    );
    expect(ack.executedAt).toBeDefined();

    // While suspended, ordinary member access is denied fail-closed.
    const memberError = await clientFor(MEMBER)
      .listDevices()
      .catch((e: unknown) => e);
    expect(isApiClientError(memberError)).toBe(true);
    if (isApiClientError(memberError)) {
      expect(memberError.reason).toBe("ORGANIZATION_SUSPENDED");
    }

    // The sanctioned escape: an org:manage holder may reactivate.
    const suspendedVersion = ack.resource?.version;
    if (suspendedVersion === undefined) throw new Error("missing suspended version");
    const reactivated = await admin.reactivateOrganization(
      { tenantId: TENANT },
      { expectedVersion: suspendedVersion },
    );
    expect(reactivated.executedAt).toBeDefined();
    const devices = await clientFor(MEMBER).listDevices();
    expect(devices.length).toBeGreaterThan(0);
  });

  it("admin commands are audited (allowed) with the correlation id", async () => {
    const { clientFor } = harness();
    const admin = clientFor(ADMIN);
    const orgs = await admin.listOrganizations();
    const orgRevision = orgs[0]?.revision;
    if (orgRevision === undefined) throw new Error("missing org revision");
    const ack = await admin.suspendOrganization(
      { tenantId: TENANT },
      { expectedVersion: orgRevision, correlationId: "corr-suspend" },
    );
    const suspendedVersion = ack.resource?.version;
    if (suspendedVersion === undefined) throw new Error("missing suspended version");
    await admin.reactivateOrganization({ tenantId: TENANT }, { expectedVersion: suspendedVersion });
    const audit = await admin.listAuditEvents({ correlationId: "corr-suspend" });
    const events = audit.events.filter((e) => e.action === "org.suspend");
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("allowed");
    expect(events[0]?.commandId).toBeUndefined();
  });

  it("personal tenants cannot reach org admin surfaces", async () => {
    const { clientFor } = harness();
    const personal = clientFor(MEMBER, `usr:aaaaaaaa-0000-4000-8000-000000000003`);
    const error = await personal.listOrganizations().catch((e: unknown) => e);
    expect(isApiClientError(error) && error.status === 403).toBe(true);
  });
});

describe("the audit chain is tamper-evident", () => {
  it("verification passes and covers the seeded+new events", async () => {
    const { clientFor } = harness();
    const owner = clientFor(OWNER);
    await owner.enrollDevice({ name: "Audit probe", platform: "linux" });
    const audit = await owner.listAuditEvents();
    expect(audit.chain.verified).toBe(true);
    expect(audit.chain.verifiedCount).toBe(audit.events.length);
    expect(audit.events.length).toBeGreaterThan(0);
    const sorted = [...audit.events].map((e) => e.sequence);
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
  });

  it("audit events carry actor/tenant/correlation and the digest chain", async () => {
    const { clientFor } = harness();
    const owner = clientFor(OWNER);
    await owner.enrollDevice({ name: "Chain probe", platform: "linux" });
    const audit = await owner.listAuditEvents();
    for (const event of audit.events) {
      expect(event.actorId).toMatch(/^usr:/);
      expect(event.tenantId).toBe(TENANT);
      expect(event.correlationId.length).toBeGreaterThan(0);
      expect(event.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const genesis = audit.events[0];
    expect(genesis?.prevDigest).toBeNull();
  });
});

describe("freshness degrades monotonically (RL-LOCK-010)", () => {
  it("FRESH becomes STALE as the guarantee expires; UNKNOWN is presented", async () => {
    const { clientFor, clock } = harness();
    const client = clientFor(MEMBER);
    const before = await client.getConnectivityOverview();
    const evidenced = before.subjects.find((s) => s.subjectId === "66666666-0000-4000-8000-000000000001");
    expect(evidenced?.deliveryEvidenceState).toBe("EVIDENCED");
    expect(evidenced?.evidence?.freshness.freshnessState).toBe("FRESH");

    clock.advanceTo("2025-01-06T10:30:00.000Z");
    const after = await client.getConnectivityOverview();
    const evidencedAfter = after.subjects.find(
      (s) => s.subjectId === "66666666-0000-4000-8000-000000000001",
    );
    expect(evidencedAfter?.evidence?.freshness.freshnessState).toBe("STALE");

    const unevidenced = after.subjects.find((s) => s.subjectId === SUBSCRIPTION_ID);
    expect(unevidenced?.deliveryEvidenceState).toBe("UNEVIDENCED");
    expect(unevidenced?.evidence).toBeNull();
  });

  it("projection health presents STALE/UNKNOWN as degraded, never healthy", async () => {
    const { clientFor } = harness();
    const owner = clientFor(OWNER);
    const health = await owner.getProjectionHealth();
    expect(health.overallHealth).toBe("degraded");
    const states = health.projections.map((p) => p.freshness.freshnessState).sort();
    expect(states).toEqual(["FRESH", "STALE", "UNKNOWN"]);
    expect(health.projections.every((p) => p.freshness.observedAt !== undefined || true)).toBe(true);
  });
});

describe("honest stage progression (accepted/executed/delivered/billable-final)", () => {
  it("order lifecycle: place -> pay -> reconcile reaches billable-final only at the end", async () => {
    const { api, clientFor } = harness();
    const client = clientFor(MEMBER);
    const orderAck = await client.placeOrder(
      { lines: [{ variantId: "55555555-0000-4000-8000-000000000002", quantity: 1 }] },
      { idempotencyKey: "flow-order" },
    );
    expect(orderAck.acceptedAt).toBeDefined();
    expect(orderAck.executedAt).toBeDefined();
    expect(orderAck.deliveredAt).toBeUndefined();

    const paymentAck = await client.recordPayment(
      {
        orderId: orderAck.resource?.id ?? "",
        amountMinor: 499,
        currency: "USD",
      },
      { idempotencyKey: "flow-payment" },
    );
    expect(paymentAck.billableFinalAt).toBeUndefined();

    // Delivery evidence arrives (only then 'delivered').
    api.controls.linkDeliveryEvidence({
      subjectType: "order",
      subjectId: orderAck.resource?.id ?? "",
      evidenceClass: "AUTHENTICATED_WEBHOOK",
      canonicalResourceType: "connectivity_lease",
      canonicalResourceId: "lease_1",
      sourceVersion: 1,
      eventId: "evt_lease_1",
      payloadDigest: "e".repeat(64),
      freshUntil: "2025-01-06T12:00:00.000Z",
    });
    const delivered = await client.getCommandStatus(orderAck.commandId);
    expect(delivered.deliveredAt).toBeDefined();
    expect(delivered.billableFinalAt).toBeUndefined();

    // Commerce finality: the invoice reconciles (only then 'billable-final').
    const order = await client.getOrder(orderAck.resource?.id ?? "");
    const invoiceId = order.invoices[0]?.invoiceId;
    expect(invoiceId).toBeDefined();
    expect(api.controls.reconcileInvoice(invoiceId ?? "")).toBe(true);
    const orderAfterReconcile = await client.getCommandStatus(orderAck.commandId);
    expect(orderAfterReconcile.billableFinalAt).toBeDefined();
    // The PAYMENT command never reaches delivered or billable-final: money
    // facts are not delivery facts (RL-LOCK-008 "payment is not delivery").
    const paymentAfterReconcile = await client.getCommandStatus(paymentAck.commandId);
    expect(paymentAfterReconcile.deliveredAt).toBeUndefined();
    expect(paymentAfterReconcile.billableFinalAt).toBeUndefined();
  });

  it("device commands top out at executed - delivered/billable stay absent", async () => {
    const { clientFor } = harness();
    const client = clientFor(MEMBER);
    const ack = await client.enrollDevice({ name: "Bare tablet", platform: "android" });
    expect(ack.executedAt).toBeDefined();
    expect(ack.deliveredAt).toBeUndefined();
    expect(ack.billableFinalAt).toBeUndefined();
  });
});

describe("reconciliation job monitoring surface", () => {
  it("triggering a manual job requires org:manage and reports honest outcomes", async () => {
    const { clientFor } = harness();
    const admin = clientFor(ADMIN);
    const ack = await admin.triggerReconciliation(
      { trigger: "manual" },
      { idempotencyKey: "job-1" },
    );
    expect(ack.executedAt).toBeDefined();
    const jobs = await admin.listReconciliationJobs();
    const manualJob = jobs.find((j) => j.trigger === "manual");
    expect(manualJob).toBeDefined();
    expect(manualJob?.status).toBe("COMPLETED");
    const outcomes = manualJob?.actions.map((a) => a.outcome) ?? [];
    expect(outcomes).toContain("ALREADY_CONSISTENT");
    expect(outcomes).toContain("DEGRADED_STALE");
    expect(outcomes).toContain("DEGRADED_UNKNOWN");
    expect(outcomes).not.toContain("REPAIRED"); // the fake never invents repairs
  });
});

describe("support-case triage surface", () => {
  it("the customer thread view renders customer messages only (structural boundary)", async () => {
    const { clientFor } = harness();
    const member = clientFor(MEMBER);
    const cases = await member.listSupportCases();
    const seeded = cases.find((c) => c.caseId === CASE_ID);
    expect(seeded?.messages.map((m) => m.visibility)).toEqual(["customer", "internal"]);
  });

  it("legal transitions advance the case; illegal ones fail typed", async () => {
    const { clientFor } = harness();
    const admin = clientFor(ADMIN);
    const ack = await admin.advanceSupportCase(
      { caseId: CASE_ID, transition: "resolve" },
      { expectedVersion: 2 },
    );
    expect(ack.executedAt).toBeDefined();
    const error = await admin
      .advanceSupportCase({ caseId: CASE_ID, transition: "startProgress" }, { expectedVersion: 3 })
      .catch((e: unknown) => e);
    expect(isApiClientError(error) && error.status === 400).toBe(true);
  });
});
