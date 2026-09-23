/**
 * Customer refund read-mirror tests (PA-002, closes RL-115-F4, additive).
 *
 * Locks the app-contract surface the order journey renders:
 *  - the mirrored closed vocabularies (state / reason codes / failure
 *    reasons) stay exactly the domain read model's members (the wave4-a
 *    drift guard pins the STATE pair against
 *    packages/domain-commerce/src/refund-read.ts; these pins hold the
 *    reason vocabularies to the same discipline — the domain package's own
 *    tests prove those equal the CustomerRefund aggregate's);
 *  - the section parser is additive-tolerant (RL-LOCK-017): an older
 *    payload without the section parses to the honest NULL section, an
 *    empty section parses to the composed no-refunds world;
 *  - the parser fails closed: non-arrays, unknown fields,
 *    out-of-vocabulary states/reasons, duplicate refund ids and malformed
 *    money reject (never a guessed refund);
 *  - the typed client reads the seeded refund section through the fake:
 *    the seeded order carries the multi-refund PARTIAL payment case (one
 *    succeeded partial refund + one pending, both against the order's one
 *    succeeded payment), the freshness pairing is evaluated at the query
 *    instant, the no-refund tenant composes the honest EMPTY section, and
 *    a tenant composing no refunds read degrades to the null section.
 */
import { describe, expect, it } from "vitest";

import {
  createInMemoryApi,
  CUSTOMER_REFUND_FAILURE_RESOURCE_REASONS,
  CUSTOMER_REFUND_RESOURCE_STATES,
  fakeApiSeed,
  parseOrderDetailResource,
  parseRefundSection,
  REFUND_REASON_RESOURCE_CODES,
  RoamLinkApiClient,
} from "../src/index.js";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";
import type { FakeApiSeed, FakeTenantSeed } from "../src/index.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const OTHER_TENANT = "org:99999999-8888-4777-8666-555555555555";
const OTHER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000004";
const SEED_ORDER_ID = "66666666-0000-4000-8000-000000000001";
const SEED_PAYMENT_ID = "90909090-0000-4000-8000-000000000001";
const OTHER_ORDER_ID = "66666666-0000-4000-8000-000000000002";

function buildClient(actor: string, tenant: string, seed?: FakeApiSeed) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const ids = new DeterministicUuidGenerator(9100);
  const fake = createInMemoryApi(seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => ids.next(),
  });
  return new RoamLinkApiClient({
    transport: fake.transport,
    actor: { actorId: actor, tenantId: tenant },
    ids: new DeterministicUuidGenerator(9600),
  });
}

function refundView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    refundId: "3e3e3e3e-0000-4000-8000-0000000000f1",
    paymentId: SEED_PAYMENT_ID,
    state: "succeeded",
    amount: { amountMinor: 500, currency: "USD" },
    reasonCode: "customer_request",
    freshness: {
      observedAt: "2025-01-06T09:00:00.000Z",
      receivedAt: "2025-01-06T09:00:00.000Z",
      freshUntil: "2025-01-06T10:00:00.000Z",
      freshnessState: "FRESH",
    },
    ...overrides,
  };
}

describe("the refund read mirror vocabularies (PA-002, RL-115-F4)", () => {
  it("the mirrored vocabularies stay closed and member-for-member the domain read model's", () => {
    // The domain read model's vocabularies are the CustomerRefund
    // aggregate's own (proven in packages/domain-commerce's tests); the
    // wave4-a drift guard pins the STATE pair file-to-file. These pins hold
    // every mirror to the same literal discipline.
    expect(CUSTOMER_REFUND_RESOURCE_STATES).toEqual(["pending", "succeeded", "failed", "cancelled"]);
    expect(REFUND_REASON_RESOURCE_CODES).toEqual([
      "customer_request",
      "service_not_delivered",
      "billing_error",
      "duplicate_charge",
      "goodwill",
      "other",
    ]);
    expect(CUSTOMER_REFUND_FAILURE_RESOURCE_REASONS).toEqual([
      "processor_error",
      "payment_instrument_unreachable",
      "compliance_hold",
      "cancelled_by_operator",
    ]);
  });
});

describe("the refund section parser (additive, fail-closed)", () => {
  it("an absent or null section parses to the honest null section (RL-LOCK-017)", () => {
    expect(parseRefundSection("OrderDetailResource.refunds", undefined)).toBeNull();
    expect(parseRefundSection("OrderDetailResource.refunds", null)).toBeNull();
  });

  it("an empty section parses to the composed no-refunds world (never a collapsed absence)", () => {
    const section = parseRefundSection("OrderDetailResource.refunds", []);
    expect(section).toEqual([]);
  });

  it("parses well-formed views, frozen, with the freshness pairing verbatim", () => {
    const section = parseRefundSection("OrderDetailResource.refunds", [
      refundView(),
      refundView({
        refundId: "3e3e3e3e-0000-4000-8000-0000000000f2",
        state: "failed",
        reasonCode: "duplicate_charge",
        failureReason: "processor_error",
        note: "Retrying next cycle.",
      }),
    ]);
    expect(section?.length).toBe(2);
    const succeeded = section?.[0];
    expect(succeeded?.state).toBe("succeeded");
    expect(succeeded?.reasonCode).toBe("customer_request");
    expect(succeeded?.amount.amountMinor).toBe(500);
    expect(succeeded?.amount.currency).toBe("USD");
    expect(succeeded?.freshness.freshnessState).toBe("FRESH");
    const failed = section?.[1];
    expect(failed?.state).toBe("failed");
    expect(failed?.failureReason).toBe("processor_error");
    expect(Object.isFrozen(section)).toBe(true);
    expect(Object.isFrozen(failed)).toBe(true);
  });

  it("fails closed: non-array section, unknown field, out-of-vocabulary values, duplicate ids, malformed money", () => {
    expect(() => parseRefundSection("OrderDetailResource.refunds", { not: "array" })).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [
        refundView({ protocol: "card-network" }),
      ]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [refundView({ state: "captured" })]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [
        refundView({ state: "partially_refunded" }),
      ]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [refundView({ reasonCode: "apology" })]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [
        refundView({ failureReason: "insufficient_funds" }),
      ]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [
        refundView(),
        refundView({ note: "duplicate id" }),
      ]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [
        refundView({ amount: { amountMinor: 5.5, currency: "USD" } }),
      ]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [
        refundView({ amount: { amountMinor: -1, currency: "USD" } }),
      ]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [
        refundView({ amount: { amountMinor: 500, currency: "usd" } }),
      ]),
    ).toThrow();
    expect(() =>
      parseRefundSection("OrderDetailResource.refunds", [refundView({ freshness: null })]),
    ).toThrow();
  });

  it("the order detail parser carries the section additively (older payloads parse to the null section)", () => {
    const orderDetail = {
      order: {
        orderId: SEED_ORDER_ID,
        status: "placed",
        lines: [
          {
            lineId: "77777777-0000-4000-8000-000000000001",
            productId: "44444444-0000-4000-8000-000000000001",
            variantId: "55555555-0000-4000-8000-000000000001",
            quantity: 1,
            unitPrice: { amountMinor: 1999, currency: "USD" },
          },
        ],
        total: { amountMinor: 1999, currency: "USD" },
        revision: 1,
        createdAt: "2025-01-06T09:00:00.000Z",
        updatedAt: "2025-01-06T09:00:00.000Z",
      },
      payments: [
        {
          paymentId: SEED_PAYMENT_ID,
          orderId: SEED_ORDER_ID,
          amount: { amountMinor: 1999, currency: "USD" },
          state: "succeeded",
          recordedAt: "2025-01-06T09:06:00.000Z",
        },
      ],
      invoices: [
        {
          invoiceId: "bbbbbbbb-0000-4000-8000-000000000001",
          orderId: SEED_ORDER_ID,
          amount: { amountMinor: 1999, currency: "USD" },
          state: "issued",
          provenanceSummary: { succeededPayments: 1, succeededRefunds: 0 },
          issuedAt: "2025-01-06T09:06:00.000Z",
        },
      ],
    };
    // The pre-PA-002 wire (no refunds field) still parses - to the honest
    // null section.
    const legacy = parseOrderDetailResource(orderDetail);
    expect(legacy.refunds).toBeNull();
    expect(legacy.payments.length).toBe(1);
    // The additive wire parses through the same resource.
    const withRefunds = parseOrderDetailResource({
      ...orderDetail,
      refunds: [refundView()],
    });
    expect(withRefunds.refunds?.length).toBe(1);
    expect(withRefunds.refunds?.[0]?.state).toBe("succeeded");
    // A malformed section fails the whole read closed (no partial pages).
    expect(() => parseOrderDetailResource({ ...orderDetail, refunds: "nope" })).toThrow();
    expect(() =>
      parseOrderDetailResource({
        ...orderDetail,
        refunds: [refundView({ state: "voided" })],
      }),
    ).toThrow();
  });
});

describe("the fake's refund read composition (the seeded honest worlds)", () => {
  it("reads the seeded multi-refund partial payment case with the freshness pairing at the query instant", async () => {
    const client = buildClient(MEMBER_ACTOR, TENANT);
    const detail = await client.getOrder(SEED_ORDER_ID);
    // The section is composed: two refunds against the order's one
    // succeeded payment (500 + 250 <= 1999 - the partial-refund bounds).
    expect(detail.refunds).not.toBeNull();
    expect(detail.refunds?.length).toBe(2);
    const succeeded = detail.refunds?.find((r) => r.refundId.endsWith("000000000001"));
    const pending = detail.refunds?.find((r) => r.refundId.endsWith("000000000002"));
    expect(succeeded?.state).toBe("succeeded");
    expect(succeeded?.reasonCode).toBe("customer_request");
    expect(succeeded?.note).toBe("Partial refund for the unused days.");
    expect(succeeded?.paymentId).toBe(SEED_PAYMENT_ID);
    expect(succeeded?.amount.amountMinor).toBe(500);
    expect(CUSTOMER_REFUND_RESOURCE_STATES).toContain(succeeded?.state);
    expect(pending?.state).toBe("pending");
    expect(pending?.reasonCode).toBe("billing_error");
    expect(pending?.amount.amountMinor).toBe(250);
    // The freshness pairing is evaluated at the query instant (09:45 < 10:00).
    expect(succeeded?.freshness.freshnessState).toBe("FRESH");
    expect(succeeded?.freshness.freshUntil).toBe("2025-01-06T10:00:00.000Z");
    expect(pending?.freshness.freshnessState).toBe("FRESH");
  });

  it("the no-refund tenant composes the honest EMPTY section (never a null guess)", async () => {
    const client = buildClient(OTHER_ACTOR, OTHER_TENANT);
    const detail = await client.getOrder(OTHER_ORDER_ID);
    expect(detail.refunds).not.toBeNull();
    expect(detail.refunds).toEqual([]);
    // The order's commercial facts compose alongside (money facts, separate).
    expect(detail.payments.length).toBe(1);
    expect(detail.payments[0]?.state).toBe("succeeded");
  });

  it("a tenant composing no refunds read degrades to the honest null section (RL-LOCK-017)", async () => {
    const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
    const tenant = seed.tenants[TENANT];
    if (tenant === undefined) throw new Error("missing tenant in seed");
    const { refunds: _stripped, ...rest } = tenant;
    const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants, [TENANT]: rest };
    const client = buildClient(MEMBER_ACTOR, TENANT, { ...seed, tenants });
    const detail = await client.getOrder(SEED_ORDER_ID);
    // No refund read composed: the null section, never an invented refund.
    expect(detail.refunds).toBeNull();
    // The rest of the order detail still composes (additive, not breaking).
    expect(detail.order.orderId).toBe(SEED_ORDER_ID);
    expect(detail.payments.length).toBe(1);
  });
});
