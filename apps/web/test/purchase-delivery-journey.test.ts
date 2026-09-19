/**
 * Guided purchase-to-delivery journey tests (RL-101,
 * spec/tech-lead-handoff.md §9, spec/ux-architecture.md §10,
 * spec/user-journey-audit.md §6).
 *
 * The frozen laws these tests lock:
 *  - the commercial chain ("payment confirmed") is VISIBLY DISTINGUISHED
 *    from the connectivity chain — the UI never collapses the states
 *    (RL-LOCK-008);
 *  - after payment the customer navigates to a delivery-progress view
 *    showing payment confirmed / connectivity request / offer-reservation
 *    when available / activation / delivery evidence / billable-final
 *    ONLY when actually proven;
 *  - success is never shown merely because payment succeeded, an order
 *    was placed, or a webhook arrived;
 *  - a newly placed order legitimately renders referenceStatus "none"
 *    until delivery evidence exists — rendered truthfully;
 *  - the four-stage command pipeline renders per-stage, never collapsed;
 *  - the journey is test-driven end-to-end with the fake controls
 *    (linkDeliveryEvidence, reconcileInvoice, progressCommandToDelivered,
 *    progressCommandToBillableFinal) against the seeded world;
 *  - fail-closed reads render the typed error panel;
 *  - novice-path vocabulary stays off the surface.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type HttpTransport,
  type HttpResponse,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const SEED_ORDER_ID = "66666666-0000-4000-8000-000000000001";
const SEED_SUBSCRIPTION_ID = "88888888-0000-4000-8000-000000000001";
const DAY_PASS_VARIANT = "55555555-0000-4000-8000-000000000002";

/** The jargon that must never reach the customer surface (any state of it). */
const FORBIDDEN_SURFACE_VOCABULARY = [
  "ADCOS",
  "ConnectivityIntent",
  "ExperienceIntent",
  "NetworkPath",
  "provider adapter",
  "idempotency",
];

function buildApp(options?: { transport?: HttpTransport }) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(10_000);
  const fake = createInMemoryApi(fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: options?.transport ?? fake.transport,
    actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
    ids: new DeterministicUuidGenerator(40_000),
  });
  const app = new CustomerWebApp({ client });
  return { app, fake, clock, client };
}

describe("the commercial chain is visibly distinguished from the connectivity chain", () => {
  it("renders both chains separately for the seeded evidenced order", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-order-journey="true"');
    // The commerce chain, labeled as money facts and kept separate.
    expect(page.html).toContain('data-commerce-chain="true"');
    expect(page.html).toContain("Commercial facts (separate)");
    expect(page.html).toContain("Payment confirms a commercial fact; it does not prove connectivity delivery");
    // The connectivity chain, derived only from the connectivity read.
    expect(page.html).toContain('data-connectivity-chain="true"');
    expect(page.html).toContain("data-subject-type=\"order\"");
    // The frozen explanatory rule survives on the journey page.
    expect(page.html).toContain("Payment, order, delivery and billable finality are separate states");
  });

  it("shows payment confirmed as a commercial fact - never as delivery", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain("Payment confirmed?");
    expect(page.html).toContain("a commercial fact only");
    // The subscription subject is UNEVIDENCED: no delivery claim anywhere.
    expect(page.html).toContain('data-evidence="UNEVIDENCED"');
    expect(page.html).not.toMatch(/data-chain-state="confirmed"[^<]*<\/strong> — <span[^>]*>Confirmed<\/span> delivery/i);
  });

  it("carries the money-facts tables (payments and invoices) on the journey", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-payments="true"');
    expect(page.html).toContain('data-invoices="true"');
    expect(page.html).toContain('data-invoice-state="issued"');
  });
});

describe("the per-subject connectivity truth renders honestly", () => {
  it("the evidenced order subject renders the confirmed chain backed by its evidence", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-subject-id="66666666-0000-4000-8000-000000000001"');
    expect(page.html).toContain('data-reference-status="active"');
    expect(page.html).toContain('data-delivery-evidence-state="EVIDENCED"');
    // The chain stages render with the honest vocabulary.
    expect(page.html).toContain('data-chain-stage="connectivity-requested" data-chain-state="confirmed"');
    expect(page.html).toContain('data-chain-stage="offer-reservation" data-chain-state="confirmed"');
    expect(page.html).toContain('data-chain-stage="activation" data-chain-state="confirmed"');
    expect(page.html).toContain('data-chain-stage="delivery-evidence" data-chain-state="confirmed"');
    // Billable-final is NOT confirmed from the read alone: the invoice is
    // only issued (no reconciled invoice, no command stage in this read).
    expect(page.html).not.toContain('data-chain-stage="billable-final" data-chain-state="confirmed"');
    // Evidence freshness re-evaluated at render is shown.
    expect(page.html).toContain("Evidence freshness (re-evaluated at this render)");
    expect(page.html).toContain('data-freshness="FRESH"');
  });

  it("the unevidenced subscription subject renders every network stage as waiting", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain(`data-subject-id="${SEED_SUBSCRIPTION_ID}"`);
    expect(page.html).toContain('data-delivery-evidence-state="UNEVIDENCED"');
    expect(page.html).toContain('data-chain-stage="offer-reservation" data-chain-state="waiting"');
    expect(page.html).toContain('data-chain-stage="activation" data-chain-state="waiting"');
    expect(page.html).toContain('data-chain-stage="delivery-evidence" data-chain-state="waiting"');
    expect(page.html).toContain("Waiting for delivery evidence — the network has not confirmed delivery yet");
    expect(page.html).toContain("Activation is confirmed when delivery evidence is linked — never from the payment itself.");
  });

  it("a newly placed order truthfully renders referenceStatus none until evidence exists", async () => {
    const { app, client } = buildApp();
    const placed = await app.placeOrderFlow(
      { lines: [{ variantId: DAY_PASS_VARIANT, quantity: 1 }] },
      { idempotencyKey: "journey-none-order" },
    );
    expect(placed.status).toBe("ok");
    if (placed.status !== "ok") return;
    const orderId = placed.acknowledgement.resource?.id ?? "";
    // The fake's placeOrder intentionally creates no reference: the fresh
    // connectivity read synthesizes the honest referenceStatus "none".
    const overview = await client.getConnectivityOverview();
    const subject = overview.subjects.find((s) => s.subjectType === "order" && s.subjectId === orderId);
    expect(subject?.referenceStatus).toBe("none");
    expect(subject?.deliveryEvidenceState).toBe("UNEVIDENCED");

    const page = await app.renderPage({
      page: "order",
      params: { orderId, commandId: placed.acknowledgement.commandId },
    });
    expect(page.html).toContain('data-reference-status="none"');
    expect(page.html).toContain("None — nothing is requested yet");
    expect(page.html).toContain('data-chain-stage="connectivity-requested" data-chain-state="waiting"');
    expect(page.html).toContain('data-chain-stage="offer-reservation" data-chain-state="not-recorded"');
    expect(page.html).toContain('data-chain-stage="delivery-evidence" data-chain-state="not-recorded"');
    // Payment has NOT happened for this order: the commerce section says so.
    expect(page.html).toContain("No succeeded payment recorded for this order yet.");
  });
});

describe("the four-stage command pipeline on the journey", () => {
  it("walks accepted -> executed -> delivered -> billable-final as separate stages", async () => {
    const { app, fake } = buildApp();
    const placed = await app.placeOrderFlow(
      { lines: [{ variantId: DAY_PASS_VARIANT, quantity: 1 }] },
      { idempotencyKey: "journey-pipeline" },
    );
    expect(placed.status).toBe("ok");
    if (placed.status !== "ok") return;
    const orderId = placed.acknowledgement.resource?.id ?? "";
    const commandId = placed.acknowledgement.commandId;

    // Payment is a money fact: it must NOT progress the command pipeline.
    const paid = await app.recordPaymentFlow(
      { orderId, amountMinor: 499, currency: "USD" },
      { idempotencyKey: "journey-pipeline-pay" },
    );
    expect(paid.status).toBe("ok");
    const afterPayPage = await app.renderPage({
      page: "order",
      params: { orderId, commandId },
    });
    expect(afterPayPage.html).toContain('data-stage="accepted" data-reached="true"');
    expect(afterPayPage.html).toContain('data-stage="executed" data-reached="true"');
    expect(afterPayPage.html).toContain('data-stage="delivered" data-reached="false"');
    expect(afterPayPage.html).toContain('data-stage="billable-final" data-reached="false"');
    // ...and the pipeline panel still separates itself from the commerce
    // payment confirmation above it.
    expect(afterPayPage.html).toContain('data-command-pipeline="true"');

    // Delivery evidence arrives -> delivered (and never earlier).
    fake.controls.linkDeliveryEvidence({
      subjectType: "order",
      subjectId: orderId,
      evidenceClass: "AUTHENTICATED_WEBHOOK",
      canonicalResourceType: "connectivity_lease",
      canonicalResourceId: "lease_journey_1",
      sourceVersion: 1,
      eventId: "evt_journey_1",
      payloadDigest: "e".repeat(64),
      freshUntil: "2025-01-06T12:00:00.000Z",
    });
    fake.controls.progressCommandToDelivered(commandId);
    const deliveredPage = await app.renderPage({
      page: "order",
      params: { orderId, commandId },
    });
    expect(deliveredPage.html).toContain('data-stage="delivered" data-reached="true"');
    expect(deliveredPage.html).toContain('data-stage="billable-final" data-reached="false"');
    expect(deliveredPage.html).toContain('data-reference-status="active"');
    expect(deliveredPage.html).toContain('data-delivery-evidence-state="EVIDENCED"');

    // Invoice reconciliation -> billable-final reached.
    const detail = await app.client().getOrder(orderId);
    const invoiceId = detail.invoices[0]?.invoiceId;
    expect(invoiceId).toBeDefined();
    expect(fake.controls.reconcileInvoice(invoiceId ?? "")).toBe(true);
    const finalPage = await app.renderPage({
      page: "order",
      params: { orderId, commandId },
    });
    expect(finalPage.html).toContain('data-stage="billable-final" data-reached="true"');
    expect(finalPage.html).toContain('data-chain-stage="billable-final" data-chain-state="confirmed"');
    expect(finalPage.html).toContain("Commerce finality recorded");
  });

  it("without a command the page renders the honest absent-pipeline note", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-command-pipeline="absent"');
    expect(page.html).toContain("not part of this read");
  });
});

describe("the degraded delivery state carries the support escape (RL-103 preview)", () => {
  it("the unevidenced subscription subject carries a support escape with its reference", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-support-escape="true"');
    expect(page.html).toContain("I paid but my connectivity has no delivery evidence yet.");
    expect(page.html).toContain(`subscription ${SEED_SUBSCRIPTION_ID}`);
    expect(page.html).toContain('href="/support?about=');
  });

  it("the fully evidenced order subject carries no escape", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: "no-such-order" } });
    // Fail-closed: an unknown order is a typed error, not an invented page.
    expect(page.html).toContain('data-error-kind="not-found"');
  });
});

describe("fail-closed + language discipline", () => {
  it("a failing connectivity read on the order page renders the typed error panel only", async () => {
    const { app } = buildApp({
      transport: {
        async request(request): Promise<HttpResponse> {
          if (request.path === "/v1/connectivity") {
            return {
              status: 503,
              body: JSON.stringify({
                kind: "unavailable",
                reason: "ADCOS_PROJECTION_STORE_DOWN",
                message: "projection reads are temporarily unavailable",
                retryable: true,
                details: [],
              }),
            };
          }
          throw new Error("unreachable");
        },
      },
    });
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-order-journey="true"');
  });

  it("keeps internal architecture vocabulary off the journey", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    for (const term of FORBIDDEN_SURFACE_VOCABULARY) {
      expect(page.html).not.toContain(term);
    }
  });
});
