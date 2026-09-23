/**
 * Customer refund read model tests (PA-002, closes RL-115-F4).
 *
 * Proves the READ-ONLY record's honest-state contract: the closed state /
 * reason-code / failure-reason vocabularies MIRRORED member-for-member from
 * the CustomerRefund aggregate (never redefined, never merged with another
 * state family — RL-LOCK-008), the fail-closed parse (unknown fields,
 * version gate, unknown ids, out-of-vocabulary values, bad amounts), the
 * honest-state invariants (a `failed` refund carries its typed failure
 * reason — and only a failed refund does; the aggregate's audit
 * completeness), the section parse (duplicate refund ids reject), and that
 * the module exposes NO write path (refund EXECUTION lives upstream in the
 * aggregate's transition machinery — the module owns parse + vocabularies
 * only).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";

import {
  CUSTOMER_REFUND_STATES,
  REFUND_FAILURE_REASONS,
  REFUND_REASON_CODES,
} from "../src/refund.js";
import {
  REFUND_READ_FAILURE_REASONS,
  REFUND_READ_REASON_CODES,
  REFUND_READ_STATES,
  isRefundReadFailureReason,
  isRefundReadReasonCode,
  isRefundReadState,
  parseRefundReadRecord,
  parseRefundReadSection,
} from "../src/refund-read.js";

const AT = "2026-02-01T10:00:00.000Z";
const TENANT = "org:00000000-0000-4000-8000-0000000000aa";
const REFUND_ID = "00000000-0000-4000-8000-0000000000f4";
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000f5";

function recordInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: "0.1",
    tenantId: TENANT,
    refundId: REFUND_ID,
    paymentId: PAYMENT_ID,
    amount: { amountMinorUnits: 500, currency: "USD" },
    reasonCode: "customer_request",
    note: "Partial refund for the unused portion.",
    state: "succeeded",
    freshness: {
      observedAt: AT,
      receivedAt: AT,
      freshUntil: "2026-02-01T12:00:00.000Z",
      freshnessState: "FRESH",
    },
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
    ...overrides,
  };
}

describe("the customer refund read record (PA-002, RL-115-F4)", () => {
  it("parses a succeeded record with its facts, frozen", () => {
    const record = parseRefundReadRecord(recordInput());
    expect(record.refundId).toBe(REFUND_ID);
    expect(record.paymentId).toBe(PAYMENT_ID);
    expect(record.state).toBe("succeeded");
    expect(record.reasonCode).toBe("customer_request");
    expect(record.amount.amountMinorUnits).toBe(500);
    expect(record.amount.currency).toBe("USD");
    expect(record.note).toBe("Partial refund for the unused portion.");
    expect(record.freshness.freshnessState).toBe("FRESH");
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("parses the pending and cancelled states (terminal states stay separate, never collapsed)", () => {
    const pending = parseRefundReadRecord(recordInput({ state: "pending" }));
    expect(pending.state).toBe("pending");
    expect("failureReason" in pending).toBe(false);
    const cancelled = parseRefundReadRecord(recordInput({ state: "cancelled" }));
    expect(cancelled.state).toBe("cancelled");
    expect("failureReason" in cancelled).toBe(false);
  });

  it("parses a failed record with its typed failure reason (audit completeness)", () => {
    const failed = parseRefundReadRecord(
      recordInput({ state: "failed", failureReason: "processor_error" }),
    );
    expect(failed.state).toBe("failed");
    expect(failed.failureReason).toBe("processor_error");
  });

  it("parses a stale-but-complete observation (the stale freshness pairing is a record state)", () => {
    const stale = parseRefundReadRecord(
      recordInput({
        freshness: {
          observedAt: AT,
          receivedAt: AT,
          freshUntil: "2026-02-01T09:00:00.000Z",
          freshnessState: "STALE",
        },
      }),
    );
    expect(stale.state).toBe("succeeded");
    expect(stale.freshness.freshnessState).toBe("STALE");
  });

  it("keeps the vocabularies closed and MIRRORED from the aggregate (never redefined)", () => {
    // The read model's vocabularies are the aggregate's own, member for
    // member — the compile-time `satisfies` proofs pin the subset
    // direction; these runtime proofs pin the full equality both ways.
    expect([...REFUND_READ_STATES]).toEqual([...CUSTOMER_REFUND_STATES]);
    expect([...REFUND_READ_REASON_CODES]).toEqual([...REFUND_REASON_CODES]);
    expect([...REFUND_READ_FAILURE_REASONS]).toEqual([...REFUND_FAILURE_REASONS]);
    expect(REFUND_READ_STATES).toEqual(["pending", "succeeded", "failed", "cancelled"]);
    expect(isRefundReadState("pending")).toBe(true);
    expect(isRefundReadState("partially_refunded")).toBe(false);
    expect(isRefundReadState("captured")).toBe(false);
    expect(isRefundReadReasonCode("goodwill")).toBe(true);
    expect(isRefundReadReasonCode("disappointed")).toBe(false);
    expect(isRefundReadFailureReason("compliance_hold")).toBe(true);
    expect(isRefundReadFailureReason("bank_closed")).toBe(false);
  });

  it("fails closed on unknown fields, bad ids, out-of-vocabulary values, bad amounts and version drift", () => {
    expect(() => parseRefundReadRecord(recordInput({ extra: true }))).toThrowError(
      ValidationError,
    );
    expect(() => parseRefundReadRecord(recordInput({ refundId: "not-a-uuid" }))).toThrowError(
      ValidationError,
    );
    expect(() => parseRefundReadRecord(recordInput({ paymentId: 42 }))).toThrowError(
      ValidationError,
    );
    expect(() => parseRefundReadRecord(recordInput({ state: "partially_refunded" }))).toThrowError(
      ValidationError,
    );
    expect(() => parseRefundReadRecord(recordInput({ reasonCode: "apology" }))).toThrowError(
      ValidationError,
    );
    expect(() =>
      parseRefundReadRecord(recordInput({ state: "failed", failureReason: "insufficient_funds" })),
    ).toThrowError(ValidationError);
    expect(() =>
      parseRefundReadRecord(recordInput({ amount: { amountMinorUnits: 5.5, currency: "USD" } })),
    ).toThrowError(ValidationError);
    expect(() =>
      parseRefundReadRecord(recordInput({ amount: { amountMinorUnits: -1, currency: "USD" } })),
    ).toThrowError(ValidationError);
    expect(() =>
      parseRefundReadRecord(recordInput({ amount: { amountMinorUnits: 100, currency: "usd" } })),
    ).toThrowError(ValidationError);
    expect(() => parseRefundReadRecord(recordInput({ contractVersion: "9.1" }))).toThrowError(
      ValidationError,
    );
    expect(() => parseRefundReadRecord(recordInput({ createdAt: "2026-02-01" }))).toThrowError(
      ValidationError,
    );
    expect(() => parseRefundReadRecord(recordInput({ revision: 0 }))).toThrowError(
      ValidationError,
    );
    expect(() =>
      parseRefundReadRecord(recordInput({ freshness: { observedAt: AT } })),
    ).toThrowError(ValidationError);
  });

  it("a failed refund must record its typed failure reason (fail-closed on doctored records)", () => {
    expect(() => parseRefundReadRecord(recordInput({ state: "failed" }))).toThrowError(
      ValidationError,
    );
  });

  it("only a failed refund carries a failure reason (never a collapsed state)", () => {
    for (const state of ["pending", "succeeded", "cancelled"] as const) {
      expect(() =>
        parseRefundReadRecord(recordInput({ state, failureReason: "processor_error" })),
      ).toThrowError(ValidationError);
    }
  });

  it("the note stays printable and bounded (the aggregate's bound)", () => {
    expect(() => parseRefundReadRecord(recordInput({ note: "" }))).toThrowError(ValidationError);
    expect(() => parseRefundReadRecord(recordInput({ note: "a".repeat(281) }))).toThrowError(
      ValidationError,
    );
    expect(() => parseRefundReadRecord(recordInput({ note: "bad\nnote" }))).toThrowError(
      ValidationError,
    );
  });

  it("the section parse rejects non-arrays and duplicate refund ids", () => {
    expect(() => parseRefundReadSection(null)).toThrowError(ValidationError);
    expect(() => parseRefundReadSection(recordInput())).toThrowError(ValidationError);
    const one = recordInput();
    const duplicate = recordInput({ note: undefined });
    expect(() => parseRefundReadSection([one, duplicate])).toThrowError(ValidationError);
    // A well-formed section parses, frozen, ids unique.
    const section = parseRefundReadSection([
      recordInput(),
      recordInput({
        refundId: "00000000-0000-4000-8000-0000000000f6",
        state: "pending",
        reasonCode: "billing_error",
        note: undefined,
      }),
    ]);
    expect(section.length).toBe(2);
    expect(section[1]?.state).toBe("pending");
    expect("note" in (section[1] ?? {})).toBe(false);
    expect(Object.isFrozen(section)).toBe(true);
  });

  it("the module owns no refund write path (read-only by construction)", async () => {
    // The authority fence: the refund read module exports parse +
    // vocabularies ONLY — no command applier, no succeed/fail/cancel
    // transition, no editor. Refund EXECUTION lives upstream in the
    // CustomerRefund aggregate's transition machinery; importing this
    // module must not surface any write machinery. (Type-only exports are
    // invisible at runtime, so this pins the runtime surface exactly.)
    const module = await import("../src/refund-read.js");
    const exported = Object.keys(module).sort();
    expect(exported).toEqual(
      [
        "REFUND_READ_FAILURE_REASONS",
        "REFUND_READ_REASON_CODES",
        "REFUND_READ_STATES",
        "isRefundReadFailureReason",
        "isRefundReadReasonCode",
        "isRefundReadState",
        "parseRefundReadRecord",
        "parseRefundReadSection",
      ].sort(),
    );
    for (const name of exported) {
      expect(name, "no write-path export").not.toMatch(
        /apply|command|transition|create|update|edit|write|enroll|provision|execute|mutate|advance/i,
      );
      // Refund-specific write verbs: the aggregate's transitions must not
      // surface as functions of this module (word-boundary anchored so the
      // failure-REASON vocabulary's 'failure'/'cancelled' members do not
      // false-positive).
      expect(name, "no aggregate transition export").not.toMatch(
        /\b(succeed|succeeded|fail|failed|cancel|cancelled|cancelledByOperator)Refund|refund(Succeed|Fail|Cancel)/i,
      );
    }
  });
});
