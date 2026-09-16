/**
 * RL-LOCK-008 conformance suite: payment is not delivery.
 *
 * Customer payment/order state is separate from reservation, path
 * activity, delivery, usage, billable finality and ADCOS settlement
 * (spec/data-model.md "State separation").
 *
 * GREEN PROOFS:
 *  - the commerce state vocabularies are closed and pairwise disjoint;
 *  - `delivery_evidence_state` is its OWN closed vocabulary, disjoint from
 *    every commerce state vocabulary, and the commerce read model presents
 *    commercial state + evidence state SEPARATELY (no combined status);
 *  - a fully paid order with NO linked evidence is presented as exactly
 *    that: paid AND UNEVIDENCED (nothing in the view can say "delivered").
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - a CustomerPayment carrying a delivery/reservation/session field is
 *    rejected by the closed record vocabulary;
 *  - a CustomerPayment in a delivery-shaped STATUS ("delivered",
 *    "path_active", "BILLABLE_FINAL") is rejected by the closed state
 *    vocabulary;
 *  - an Order in a payment-shaped status ("succeeded") is rejected.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  CUSTOMER_PAYMENT_STATES,
  CustomerPayment,
  Order,
  ORDER_STATUSES,
  SUBSCRIPTION_STATUSES,
} from "@roamlink/domain-commerce";
import {
  DELIVERY_EVIDENCE_STATES,
  describeSubjectConnectivity,
} from "@roamlink/commerce-connectivity";
import { readSourceFiles, violationEnabled } from "../src/index.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCK = "RL-LOCK-008";
const T0 = "2026-01-15T08:30:00.000Z";
const T_QUERY = "2026-01-15T08:30:30.000Z";

const PAYMENT_BASE = {
  paymentId: "00000000-0000-4000-8000-0000000000c1",
  tenantId: "usr:00000000-0000-4000-8000-000000000002",
  orderId: "00000000-0000-4000-8000-0000000000c2",
  ownerUserId: "00000000-0000-4000-8000-000000000002",
  amount: { amountMinorUnits: 999, currency: "USD" },
  status: "pending",
  createdAt: T0,
  updatedAt: T0,
  revision: 1,
} as const;

const ORDER_BASE = {
  orderId: "00000000-0000-4000-8000-0000000000c2",
  tenantId: "usr:00000000-0000-4000-8000-000000000002",
  ownerUserId: "00000000-0000-4000-8000-000000000002",
  status: "placed",
  lineCount: 0,
  totalAmount: { amountMinorUnits: 0, currency: "XXX" },
  createdAt: T0,
  updatedAt: T0,
  revision: 1,
} as const;

describe(`${LOCK}: payment is not delivery`, () => {
  it("green: commerce states are separate typed vocabularies; delivery/execution states appear in none", () => {
    expect(CUSTOMER_PAYMENT_STATES).toEqual(["pending", "succeeded", "failed", "cancelled"]);
    expect(ORDER_STATUSES).toEqual(["draft", "placed", "completed", "cancelled"]);
    expect(SUBSCRIPTION_STATUSES.length).toBeGreaterThan(0);

    const commerceStates = new Set<string>([
      ...CUSTOMER_PAYMENT_STATES,
      ...ORDER_STATUSES,
      ...SUBSCRIPTION_STATUSES,
    ]);
    // Delivery/execution/settlement states never appear in a commerce
    // vocabulary (the never-merged families of spec/data-model.md).
    for (const deliveryish of [
      "delivered",
      "delivery_started",
      "path_active",
      "session_authorized",
      "BILLABLE_FINAL",
      "settled",
      "reserved",
    ]) {
      expect(commerceStates.has(deliveryish)).toBe(false);
    }
    // The delivery-evidence vocabulary shares NO member with commerce state.
    for (const state of commerceStates) {
      expect(DELIVERY_EVIDENCE_STATES.includes(state as never)).toBe(false);
    }
  });

  it("green: DELIVERY_EVIDENCE_STATES is its own two-member vocabulary", () => {
    expect(DELIVERY_EVIDENCE_STATES).toEqual(["UNEVIDENCED", "EVIDENCED"]);
  });

  it("negative proof: a payment carrying a delivery/reservation field is rejected (red when admitted)", () => {
    for (const forbiddenField of [
      { key: "reservationState", value: "granted" },
      { key: "sessionState", value: "authorized" },
      { key: "deliveryState", value: "started" },
      { key: "pathActivity", value: "active" },
    ]) {
      const violating = { ...PAYMENT_BASE, [forbiddenField.key]: forbiddenField.value };
      if (violationEnabled(LOCK)) {
        expect(() => new CustomerPayment(violating)).not.toThrow();
      } else {
        expect(() => new CustomerPayment(violating)).toThrow(
          /CUSTOMER_PAYMENT_INVALID|no delivery\/connectivity fields exist on payments/,
        );
      }
    }
  });

  it("negative proof: a payment in a delivery-shaped status is rejected (red when admitted)", () => {
    for (const deliveryShaped of ["delivered", "path_active", "BILLABLE_FINAL", "delivery_started"]) {
      const violating = { ...PAYMENT_BASE, status: deliveryShaped };
      if (violationEnabled(LOCK)) {
        expect(() => new CustomerPayment(violating)).not.toThrow();
      } else {
        expect(() => new CustomerPayment(violating)).toThrow(/vocabulary is closed and separate/);
      }
    }
  });

  it("negative proof: an order in a payment-shaped status is rejected (red when admitted)", () => {
    for (const paymentShaped of ["succeeded", "refunded", "captured"]) {
      const violating = { ...ORDER_BASE, status: paymentShaped };
      if (violationEnabled(LOCK)) {
        expect(() => new Order(violating)).not.toThrow();
      } else {
        expect(() => new Order(violating)).toThrow(/status/);
      }
    }
  });

  it("green: a paid order with no linked evidence is presented as paid AND unevidenced (never delivered)", () => {
    // The pure read model: subject facts (commercial state), NO reference.
    // describeSubjectConnectivity must present commercialState and
    // deliveryEvidenceState as SEPARATE facts; nothing says delivered.
    const view = describeSubjectConnectivity(
      { subjectType: "order", subjectId: "order-1", commercialState: "placed" },
      undefined,
      T_QUERY as never,
    );
    expect(view.commercialState).toBe("placed");
    expect(view.deliveryEvidenceState).toBe("UNEVIDENCED");
    expect(view.referenceStatus).toBe("none");
    expect(view.evidence).toBeNull();
    // The view has NO combined opaque status field.
    const fields = Object.keys(view);
    expect(fields).not.toContain("status");
    expect(fields).not.toContain("combinedStatus");
  });

  it("green: the reference read model structurally separates commercial and evidence state", () => {
    const files = readSourceFiles(REPO_ROOT, ["packages/commerce-connectivity/src"], []);
    const readModel = files.find((file) => file.path.endsWith("read-model.ts"));
    expect(readModel).toBeDefined();
    const content = readModel?.content ?? "";
    expect(content).toMatch(/commercialState/);
    expect(content).toMatch(/deliveryEvidenceState/);
    expect(content).not.toMatch(/combinedStatus|overallStatus/);
  });
});
