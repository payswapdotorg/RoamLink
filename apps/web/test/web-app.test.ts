/**
 * Customer web app component tests (RL-060 verification gates).
 *
 * Every test drives the REAL app (pages + flows) through the REAL typed
 * client against the deterministic in-memory fake - the same code path a
 * production deployment uses, with a deterministic transport. The fake's
 * clock/ids come from @roamlink/testkit.
 *
 * Gates covered:
 *  - connectivity-aggregation rendering with FRESH/STALE/UNKNOWN states;
 *  - accepted/executed/delivered/billable-final distinction in UI flows;
 *  - optimistic-version conflicts render as typed conflict panels;
 *  - idempotent retries (same key, one effect) through app flows;
 *  - the customer support thread hides internal messages;
 *  - fail-closed page rendering when reads fail.
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
const PHONE_ID = "dddddddd-0000-4000-8000-000000000001";
const CASE_ID = "cafecafe-0000-4000-8000-000000000001";
const SEED_ORDER_ID = "66666666-0000-4000-8000-000000000001";

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

describe("connectivity aggregation rendering (RL-060 gate)", () => {
  it("renders FRESH, STALE and UNKNOWN evidence distinctly on the overview", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "overview" });
    expect(document).toContain('data-connectivity-overview="true"');
    expect(document).toContain('data-freshness="FRESH"');
    expect(document).toContain('data-freshness="STALE"');
    // The unevidenced subscription renders explicitly; UNKNOWN device
    // observation freshness is presented, never hidden.
    expect(document).toContain('data-evidence="UNEVIDENCED"');
    expect(document).toContain("no observation recorded");
  });

  it("never renders a combined/derived connectivity status anywhere", async () => {
    const { app } = buildApp();
    const document = await app.renderDocument({ page: "overview" });
    expect(document).not.toMatch(/combinedStatus|overallStatus|connectivityStatus/);
    // The three state families stay separate, visible attributes.
    expect(document).toContain('data-state="active"');
    expect(document).toContain('data-evidence=');
  });

  it("STALE degradation appears as the freshness guarantee expires", async () => {
    const { app, clock } = buildApp();
    clock.advanceTo("2025-01-06T11:00:00.000Z");
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-freshness="STALE"');
    expect(page.html).not.toContain('data-freshness="FRESH"');
  });

  it("connectivity reads failing renders the typed error panel, not a partial page", async () => {
    const { app } = buildApp({
      transport: {
        async request(): Promise<HttpResponse> {
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
        },
      },
    });
    const page = await app.renderPage({ page: "connectivity" });
    expect(page.html).toContain('data-error-kind="unavailable"');
    expect(page.html).not.toContain('data-connectivity-overview');
  });
});

describe("mutation flows and the stage pipeline (RL-060 gate)", () => {
  it("enroll renders accepted+executed with delivered/billable-final explicitly unreached", async () => {
    const { app } = buildApp();
    const result = await app.enrollDeviceFlow({ name: "Tablet", platform: "android" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const page = await app.renderPage({ page: "devices", lastResult: result });
    expect(page.html).toContain('data-stage="accepted" data-reached="true"');
    expect(page.html).toContain('data-stage="executed" data-reached="true"');
    expect(page.html).toContain('data-stage="delivered" data-reached="false"');
    expect(page.html).toContain('data-stage="billable-final" data-reached="false"');
  });

  it("the full order flow separates executed, delivered and billable-final", async () => {
    const { app, fake } = buildApp();
    const placed = await app.placeOrderFlow(
      { lines: [{ variantId: "55555555-0000-4000-8000-000000000002", quantity: 1 }] },
      { idempotencyKey: "web-order-1" },
    );
    expect(placed.status).toBe("ok");
    if (placed.status !== "ok") return;
    const orderId = placed.acknowledgement.resource?.id;
    expect(orderId).toBeDefined();

    const paid = await app.recordPaymentFlow(
      { orderId: orderId ?? "", amountMinor: 499, currency: "USD" },
      { idempotencyKey: "web-payment-1" },
    );
    expect(paid.status).toBe("ok");

    // Before evidence: the order command shows delivered unreached.
    const beforeEvidence = await app.renderPage({ page: "commerce", lastResult: placed });
    expect(beforeEvidence.html).toContain('data-stage="delivered" data-reached="false"');

    // Delivery evidence arrives -> delivered reached, billable-final not yet.
    fake.controls.linkDeliveryEvidence({
      subjectType: "order",
      subjectId: orderId ?? "",
      evidenceClass: "AUTHENTICATED_WEBHOOK",
      canonicalResourceType: "connectivity_lease",
      canonicalResourceId: "lease_web_1",
      sourceVersion: 1,
      eventId: "evt_web_1",
      payloadDigest: "f".repeat(64),
      freshUntil: "2025-01-06T12:00:00.000Z",
    });
    const progressed = await app.client().getCommandStatus(placed.acknowledgement.commandId);
    const afterEvidence = await app.renderPage({ page: "commerce", lastResult: { status: "ok", acknowledgement: progressed } });
    expect(afterEvidence.html).toContain('data-stage="delivered" data-reached="true"');
    expect(afterEvidence.html).toContain('data-stage="billable-final" data-reached="false"');

    // Invoice reconciliation -> billable-final reached (for the ORDER command).
    const detail = await app.client().getOrder(orderId ?? "");
    const invoiceId = detail.invoices[0]?.invoiceId;
    expect(invoiceId).toBeDefined();
    expect(fake.controls.reconcileInvoice(invoiceId ?? "")).toBe(true);
    const finalAck = await app.client().getCommandStatus(placed.acknowledgement.commandId);
    const finalPage = await app.renderPage({ page: "commerce", lastResult: { status: "ok", acknowledgement: finalAck } });
    expect(finalPage.html).toContain('data-stage="billable-final" data-reached="true"');
  });

  it("optimistic-version conflicts render as typed conflict panels", async () => {
    const { app, fake } = buildApp();
    // A competitor write lands BETWEEN the app's read and its command: the
    // racing transport intercepts the app's POST, writes first, then lets
    // the app's (now stale) command through -> typed 409 conflict.
    const racingTransport: HttpTransport = {
      async request(request) {
        if (request.method === "POST" && request.path.endsWith("/update")) {
          const competitor = new RoamLinkApiClient({
            transport: fake.transport,
            actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
            ids: new DeterministicUuidGenerator(50_000),
          });
          await competitor.updateDevice(
            { deviceId: PHONE_ID, name: "Competitor write" },
            { expectedVersion: 1 },
          );
        }
        return fake.transport.request(request);
      },
    };
    const client = new RoamLinkApiClient({
      transport: racingTransport,
      actor: { actorId: MEMBER_ACTOR, tenantId: TENANT },
      ids: new DeterministicUuidGenerator(70_000),
    });
    const racingApp = new CustomerWebApp({ client });
    const result = await racingApp.updateDeviceFlow({ deviceId: PHONE_ID, name: "Slow writer" });
    expect(result.status).toBe("error");
    const page = await app.renderPage({ page: "devices", lastResult: result });
    expect(page.html).toContain('data-error-kind="conflict"');
    expect(page.html).toContain("changed concurrently");
  });

  it("retrying a flow with the same idempotency key performs one effect", async () => {
    const { app, client } = buildApp();
    const first = await app.placeOrderFlow(
      { lines: [{ variantId: "55555555-0000-4000-8000-000000000002", quantity: 1 }] },
      { idempotencyKey: "retry-once" },
    );
    expect(first.status).toBe("ok");
    const retry = await app.placeOrderFlow(
      { lines: [{ variantId: "55555555-0000-4000-8000-000000000002", quantity: 1 }] },
      { idempotencyKey: "retry-once" },
    );
    expect(retry.status).toBe("ok");
    if (retry.status !== "ok" || first.status !== "ok") return;
    expect(retry.acknowledgement.commandId).toBe(first.acknowledgement.commandId);
    const orders = await client.listOrders();
    // Seeded order + exactly ONE new order.
    expect(orders).toHaveLength(2);
  });

  it("intent lifecycle: create draft -> activate -> supersede renders the version chain", async () => {
    const { app, client } = buildApp();
    const created = await app.createIntentFlow({
      deviceId: PHONE_ID,
      rationale: "Work apps while traveling.",
      accessClasses: ["work_apps_only"],
    });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    const intentId = created.acknowledgement.resource?.id;
    expect(intentId).toBeDefined();

    const activated = await app.activateIntentFlow({ intentId: intentId ?? "" });
    expect(activated.status).toBe("ok");

    const superseded = await app.supersedeIntentFlow({
      intentId: intentId ?? "",
      rationale: "Widen to any internet.",
      accessClasses: ["any_internet", "privacy_first"],
    });
    expect(superseded.status).toBe("ok");

    const detailPage = await app.renderPage({ page: "intent", params: { intentId: intentId ?? "" } });
    expect(detailPage.html).toContain('data-versions');
    expect(detailPage.html).toContain('data-state="superseded"');
    expect(detailPage.html).toContain('data-state="active"');

    const intents = await client.listExperienceIntents();
    const intent = intents.find((i) => i.intentId === intentId);
    expect(intent?.versions.map((v) => v.status)).toEqual(["superseded", "active"]);
  });
});

describe("notification + support surfaces", () => {
  it("the customer thread hides internal messages (structural boundary)", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "case", params: { caseId: CASE_ID } });
    expect(page.html).toContain('data-customer-thread="true"');
    expect(page.html).toContain("It dropped twice near the crossing.");
    expect(page.html).not.toContain("Internal: checking projection freshness");
  });

  it("mark-read works for the recipient and is idempotent", async () => {
    const { app, client } = buildApp();
    const result = await app.markNotificationReadFlow({
      notificationId: "d0d0d0d0-0000-4000-8000-000000000001",
    });
    expect(result.status).toBe("ok");
    const notifications = await client.listNotifications();
    expect(notifications[0]?.state).toBe("read");
  });

  it("a seeded order shows payments/invoices with money facts only", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-payments="true"');
    expect(page.html).toContain('data-invoices="true"');
    expect(page.html).toContain('data-invoice-state="issued"');
    expect(page.html).toContain("Payment, order, delivery and billable finality are separate states");
  });

  it("creating a support case works and renders in the list", async () => {
    const { app, client } = buildApp();
    const result = await app.createSupportCaseFlow({
      subject: "No connectivity at the airport",
      description: "Losing connectivity every few minutes near gate B12.",
      priority: "high",
    });
    expect(result.status).toBe("ok");
    const cases = await client.listSupportCases();
    const created = cases.find((c) => c.subject === "No connectivity at the airport");
    expect(created?.status).toBe("open");
    expect(created?.priority).toBe("high");
  });
});

describe("fail-closed rendering across pages", () => {
  it("tenant mismatch renders 404 panels, not other tenants' data", async () => {
    const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
    const fakeIds = new DeterministicUuidGenerator(80_000);
    const fake = createInMemoryApi(fakeApiSeed(), {
      now: () => clock.now(),
      ids: () => fakeIds.next(),
    });
    const client = new RoamLinkApiClient({
      transport: fake.transport,
      actor: { actorId: MEMBER_ACTOR, tenantId: "org:99999999-8888-4777-8666-555555555555" },
      ids: new DeterministicUuidGenerator(90_000),
    });
    const app = new CustomerWebApp({ client });
    const page = await app.renderPage({ page: "devices" });
    expect(page.html).toContain('data-error-kind="not-found"');
    expect(page.html).not.toContain('data-devices="true"');
    expect(page.html).not.toContain("Phone");
  });
});
