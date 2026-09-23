/**
 * Order-journey refund read section tests (PA-002, closes RL-115-F4;
 * spec/architecture.md §2 Layer B "customer-facing payment state, invoices,
 * refunds"; spec/ux-architecture.md §10/§14/§15).
 *
 * These tests lock the customer refund surface — the order journey's refund
 * section, rendered FROM THE READ ONLY:
 *  - the seeded honest world: the multi-refund PARTIAL payment case (one
 *    succeeded partial refund + one pending, both against the order's one
 *    succeeded payment) renders one row per refund with its state word,
 *    per-state fact, amount + currency, reason label, the parent payment
 *    reference and the freshness PAIRING (§14);
 *  - EVERY state × at least one refund (pending / succeeded / failed /
 *    cancelled — the closed customer_refund_state vocabulary, mirrored
 *    through the app contract, never merged with payment/invoice/order
 *    state, RL-LOCK-008);
 *  - the §14 pairing discipline: a STALE read keeps its content PAIRED with
 *    the stale badge; an UNKNOWN read says so, never a guess;
 *  - the honest absence states: an order with NO refunds renders the
 *    explicit empty section; a surface composing no refund read (the
 *    pre-PA-002 wire, RL-LOCK-017) renders the honest not-available state —
 *    never a fabricated refund;
 *  - the READ-ONLY authority fence: the section composes NO refund
 *    request/cancel control (refund EXECUTION lives upstream, in commerce
 *    operations — the authority note names it);
 *  - the §15 recovery path: the support escape (pre-carrying the order +
 *    refund references) in the degraded worlds, the quiet reachability
 *    note otherwise;
 *  - the money-facts separation: a refund never claims connectivity
 *    delivery (RL-LOCK-008).
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryApi,
  fakeApiSeed,
  RoamLinkApiClient,
  type FakeApiSeed,
  type FakeRefundSeed,
  type FakeTenantSeed,
} from "@roamlink/app-kit";
import { DeterministicClock, DeterministicUuidGenerator } from "@roamlink/testkit";

import { CustomerWebApp } from "../src/app.js";
import { deriveRefundRows } from "../src/pages/order-journey-page.js";

const TENANT = "org:11111111-2222-4333-8444-555555555555";
const MEMBER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000003";
const OTHER_TENANT = "org:99999999-8888-4777-8666-555555555555";
const OTHER_ACTOR = "usr:aaaaaaaa-0000-4000-8000-000000000004";
const SEED_ORDER_ID = "66666666-0000-4000-8000-000000000001";
const SEED_PAYMENT_ID = "90909090-0000-4000-8000-000000000002";
const NO_REFUND_ORDER_ID = "66666666-0000-4000-8000-000000000002";
const SUCCEEDED_REFUND_ID = "3e3e3e3e-0000-4000-8000-000000000001";

function buildApp(options?: { readonly seed?: FakeApiSeed; readonly actor?: string; readonly tenant?: string }) {
  const clock = new DeterministicClock("2025-01-06T09:45:00.000Z");
  const fakeIds = new DeterministicUuidGenerator(12_000);
  const fake = createInMemoryApi(options?.seed ?? fakeApiSeed(), {
    now: () => clock.now(),
    ids: () => fakeIds.next(),
  });
  const client = new RoamLinkApiClient({
    transport: fake.transport,
    actor: { actorId: options?.actor ?? MEMBER_ACTOR, tenantId: options?.tenant ?? TENANT },
    ids: new DeterministicUuidGenerator(42_000),
  });
  return { app: new CustomerWebApp({ client }), client, clock };
}

/** Derives a scenario seed by overriding the tenant's refund fixtures. */
function refundSeed(overrides: readonly Partial<FakeRefundSeed>[]): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
  const base = tenant.refunds ?? [];
  tenants[TENANT] = {
    ...tenant,
    refunds: overrides.map((override, index) => {
      // The template supplies every required field; the override only
      // rewrites (or explicitly clears, as undefined) fields the scenario
      // controls — the same cast discipline the JSON-derived seeds use.
      const template = base[index] ?? base[0];
      return { ...template, ...override } as FakeRefundSeed;
    }),
  };
  return { ...seed, tenants };
}

/** A seed whose tenant composes NO refunds read (the pre-PA-002 wire). */
function refundsNotComposedSeed(): FakeApiSeed {
  const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
  const tenant = seed.tenants[TENANT];
  if (tenant === undefined) throw new Error("missing tenant in seed");
  const { refunds: _stripped, ...rest } = tenant;
  const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants, [TENANT]: rest };
  return { ...seed, tenants };
}

/** The refund section's rendered slice (bounded by the next journey section). */
function refundSectionSlice(html: string): string {
  const start = html.indexOf('data-refunds="');
  if (start < 0) throw new Error("no refund section rendered");
  let end = html.indexOf('data-connectivity-chain="true"', start);
  if (end < 0) end = html.indexOf('data-journey-subjects-empty', start);
  if (end < 0) end = html.indexOf("data-command-pipeline", start);
  if (end < 0) end = html.length;
  return html.slice(start, end);
}

const FRESH = {
  observedAt: "2025-01-06T09:00:00.000Z",
  receivedAt: "2025-01-06T09:00:00.000Z",
  freshUntil: "2025-01-06T10:00:00.000Z",
};
const STALE = {
  observedAt: "2025-01-06T09:00:00.000Z",
  receivedAt: "2025-01-06T09:00:00.000Z",
  freshUntil: "2025-01-06T09:30:00.000Z",
};

describe("the order journey's refund section renders from the read only (PA-002, RL-115-F4)", () => {
  it("the seeded multi-refund partial payment case: one row per refund, honestly paired", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    // THE FLIP: the refund vocabulary now renders (the pinned absence is
    // gone) — the section, the heading, one row per seeded refund.
    expect(page.html).toContain('data-refunds="true"');
    expect(page.html).toContain('data-refund-rows="true"');
    expect(page.html).toContain('data-refund-id="3e3e3e3e-0000-4000-8000-000000000001"');
    expect(page.html).toContain('data-refund-id="3e3e3e3e-0000-4000-8000-000000000002"');
    // The state words (the closed customer_refund_state vocabulary, mirrored
    // through the app contract — never merged with payment state).
    expect(page.html).toContain('data-refund-state="succeeded"');
    expect(page.html).toContain('data-refund-state="pending"');
    expect(page.html).toMatch(/data-state-word="succeeded"[^<]*>Succeeded/);
    expect(page.html).toMatch(/data-state-word="pending"[^<]*>Pending/);
    // Amounts + currency (integer minor units on the wire, presented as money).
    expect(page.html).toContain("Refund 5.00 USD");
    expect(page.html).toContain("Refund 2.50 USD");
    // The reason labels (the closed reason-code label vocabulary) + the note.
    expect(page.html).toContain("Reason: You asked for this refund");
    expect(page.html).toContain("Partial refund for the unused days.");
    expect(page.html).toContain("Reason: A billing error was corrected");
    // The parent payment reference (which payment the money returns from).
    expect(page.html).toContain("Returns money from payment 90909090-0000-4000-8000-000000000001");
    // The freshness PAIRING (§14): the read state rides next to the content.
    expect(page.html).toContain("Refund read: ");
    expect(page.html).toContain('data-freshness="FRESH"');
    // The healthy verified world renders the quiet reachability note (an
    // escape is for degraded states, never decoration) — scoped to the
    // refund section (the connectivity chains own their own escapes).
    const section = refundSectionSlice(page.html);
    expect(section).toContain('data-refunds-reachability="true"');
    expect(section).not.toContain('data-support-escape="true"');
  });

  it("the money-facts separation: a refund never claims connectivity delivery (RL-LOCK-008)", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    // The section's own rule, and the per-state fact that keeps the money
    // fact separate from delivery.
    expect(page.html).toContain("A refund never claims anything about connectivity delivery");
    expect(page.html).toContain("This is a money fact only");
    // The refund section is VISIBLY DISTINCT from the delivery-evidence
    // chain: both render, never collapsed (the commerce chain and the
    // connectivity chain keep their own sections).
    expect(page.html).toContain('data-commerce-chain="true"');
    expect(page.html).toContain('data-connectivity-chain="true"');
  });

  it.each(["pending", "succeeded", "failed", "cancelled"] as const)(
    "every state x one refund: the '%s' world renders its state word, honest fact and marker",
    async (state) => {
      const seed = refundSeed([
        {
          refundId: SUCCEEDED_REFUND_ID,
          paymentId: "90909090-0000-4000-8000-000000000001",
          amountMinor: 500,
          currency: "USD",
          state,
          reasonCode: "customer_request",
          note: undefined,
          ...(state === "failed"
            ? { failureReason: "processor_error" as const }
            : { failureReason: undefined }),
          freshness: FRESH,
        },
      ]);
      const { app } = buildApp({ seed });
      const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
      expect(page.html).toContain(`data-refund-state="${state}"`);
      const stateWord: Record<string, string> = {
        pending: "Pending",
        succeeded: "Succeeded",
        failed: "Failed",
        cancelled: "Cancelled",
      };
      expect(page.html).toMatch(new RegExp(`data-state-word="${state}"[^<]*>${stateWord[state]}`));
      // The per-state honest fact.
      const fact: Record<string, string> = {
        pending: "In progress — the refund has been recorded",
        succeeded: "Completed — the recorded refund state is succeeded",
        failed: "The refund attempt failed — the payment processor reported an error",
        cancelled: "Cancelled before any money moved",
      };
      expect(page.html).toContain(fact[state] ?? "");
      // A failed refund is a degraded world: the refund section carries
      // the support escape (pre-carrying the order + the refund
      // reference); every other state renders the quiet reachability note
      // instead (scoped to the refund section — the connectivity chains
      // own their own escapes).
      const section = refundSectionSlice(page.html);
      if (state === "failed") {
        expect(section).toContain('data-support-escape="true"');
        expect(section).toContain("Get help with refunds");
        expect(section).toContain("refund 3e3e3e3e-0000-4000-8000-000000000001");
        expect(section).not.toContain('data-refunds-reachability="true"');
      } else {
        expect(section).toContain('data-refunds-reachability="true"');
        expect(section).not.toContain('data-support-escape="true"');
      }
    },
  );

  it("the stale-freshness pairing: content stays PAIRED with the stale badge (§14)", async () => {
    const seed = refundSeed([
      {
        refundId: SUCCEEDED_REFUND_ID,
        paymentId: "90909090-0000-4000-8000-000000000001",
        amountMinor: 500,
        currency: "USD",
        state: "succeeded",
        reasonCode: "customer_request",
        freshness: STALE,
      },
    ]);
    const { app } = buildApp({ seed });
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    // The state word AND the stale badge BOTH render, in the same row —
    // the content is never dropped or hidden when the read goes stale.
    const row = page.html.slice(
      page.html.indexOf(`data-refund-id="${SUCCEEDED_REFUND_ID}"`),
      page.html.indexOf("data-refunds-authority"),
    );
    expect(row).toContain('data-refund-state="succeeded"');
    expect(row).toContain(">Succeeded</span>");
    expect(row).toContain('data-freshness="STALE"');
    expect(row).toContain("Refund read: ");
    // The per-state fact qualifies itself as the last verified read.
    expect(page.html).toContain("Completed as of the last verified read");
    // The degraded world carries the support escape (the read is stale) —
    // scoped to the refund section.
    const section = refundSectionSlice(page.html);
    expect(section).toContain('data-support-escape="true"');
    expect(section).toContain("Get help with refunds");
    expect(section).not.toContain('data-refunds-reachability="true"');
  });

  it("the unknown-freshness world says so — never a guess", async () => {
    const seed = JSON.parse(JSON.stringify(fakeApiSeed())) as FakeApiSeed;
    const tenant = seed.tenants[TENANT];
    if (tenant === undefined) throw new Error("missing tenant in seed");
    const tenants: Record<string, FakeTenantSeed> = { ...seed.tenants };
    const refunds = (tenant.refunds ?? []).map((refund, index) =>
      index === 0 ? { ...refund, freshness: undefined } : refund,
    );
    tenants[TENANT] = { ...tenant, refunds };
    const { app } = buildApp({ seed: { ...seed, tenants } });
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-freshness="UNKNOWN"');
    expect(page.html).toContain("A succeeded refund record exists, but no verified observation backs this read yet.");
    expect(refundSectionSlice(page.html)).toContain('data-support-escape="true"');
  });

  it("the honest empty section: an order with no refunds (never a null guess, never a fabricated refund)", async () => {
    const { app } = buildApp({ actor: OTHER_ACTOR, tenant: OTHER_TENANT });
    const page = await app.renderPage({ page: "order", params: { orderId: NO_REFUND_ORDER_ID } });
    expect(page.html).toContain('data-refunds="empty"');
    expect(page.html).toContain('data-refunds-empty="true"');
    expect(page.html).toContain("No refunds are recorded for this order.");
    expect(page.html).not.toContain('data-refund-id=');
    // The empty world is healthy: the quiet reachability note, not an
    // escape (scoped to the refund section).
    const section = refundSectionSlice(page.html);
    expect(section).toContain('data-refunds-reachability="true"');
    expect(section).not.toContain('data-support-escape="true"');
    // The order's commercial facts still compose alongside (money facts).
    expect(page.html).toContain('data-payments="true"');
  });

  it("the honest not-available state: a surface composing no refund read (RL-LOCK-017 additive tolerance)", async () => {
    const { app } = buildApp({ seed: refundsNotComposedSeed() });
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-refunds="not-available"');
    expect(page.html).toContain('data-refunds-absent="true"');
    expect(page.html).toContain(
      "Refund state for this order is not part of this read yet. When the refund read composes, the real states appear here — nothing is invented in the meantime.",
    );
    // No refund row leaked into the degraded world.
    expect(page.html).not.toContain('data-refund-id=');
    // The rest of the order journey still composes (additive, not breaking).
    expect(page.html).toContain('data-commerce-chain="true"');
    // No refund read composed is a degraded world: the escape renders
    // (scoped to the refund section).
    const notAvailableSection = refundSectionSlice(page.html);
    expect(notAvailableSection).toContain('data-support-escape="true"');
    expect(notAvailableSection).toContain("Get help with refunds");
  });

  it("the READ-ONLY authority fence: no refund write affordance, and the authority note names where execution lives", async () => {
    const { app } = buildApp();
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    expect(page.html).toContain('data-refunds-authority="true"');
    expect(page.html).toContain("commerce operations, upstream of this journey");
    // THE NO-FABRICATION PIN: the refund section composes no form, button,
    // input or command flow — refund execution lives upstream (no customer
    // refund write contract backs any control).
    const section = refundSectionSlice(page.html);
    expect(section).not.toMatch(/<form|<button|data-flow=|<input/);
    expect(page.html).not.toMatch(/data-flow="(request|issue|create|cancel|retry|execute)-refund/);
  });

  it("the support escape pre-carries the order and refund references transparently", async () => {
    const seed = refundSeed([
      {
        refundId: SUCCEEDED_REFUND_ID,
        paymentId: "90909090-0000-4000-8000-000000000001",
        amountMinor: 500,
        currency: "USD",
        state: "failed",
        reasonCode: "goodwill",
        failureReason: "compliance_hold",
        freshness: FRESH,
      },
    ]);
    const { app } = buildApp({ seed });
    const page = await app.renderPage({ page: "order", params: { orderId: SEED_ORDER_ID } });
    const escape = page.html.slice(
      page.html.indexOf('data-support-escape="true"'),
      page.html.indexOf("Opens Support with:"),
    );
    // The carried context names the order AND the refund (typed support-ref
    // kinds) — no invented references.
    expect(escape).toContain(SEED_ORDER_ID);
    expect(escape).toContain(SUCCEEDED_REFUND_ID);
    expect(page.html).toContain("refund 3e3e3e3e-0000-4000-8000-000000000001");
  });

  it("deriveRefundRows is pure and total over the shape-legal wire worlds", () => {
    expect(deriveRefundRows(null)).toEqual([]);
    expect(deriveRefundRows(undefined)).toEqual([]);
    expect(deriveRefundRows([])).toEqual([]);
    const rows = deriveRefundRows([
      {
        refundId: "r1",
        paymentId: SEED_PAYMENT_ID,
        state: "cancelled",
        amount: { amountMinor: 100, currency: "EUR" },
        reasonCode: "other",
        freshness: {
          observedAt: null,
          receivedAt: null,
          freshUntil: null,
          freshnessState: "UNKNOWN",
        },
      },
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.reasonLabel).toBe("A recorded reason");
    expect(rows[0]?.state).toBe("cancelled");
    expect(rows[0]?.freshness.freshnessState).toBe("UNKNOWN");
    expect(rows[0]?.fact).toContain("A cancelled refund record exists");
  });
});
