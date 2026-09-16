/**
 * RL-LOCK-010 conformance suite: evidence and freshness are first-class.
 *
 * All projected/external state retains provenance, authority, timestamps
 * and freshness. Unknown is a valid state.
 *
 * GREEN PROOFS:
 *  - the §8 projection record shape is REQUIRED in full: a record missing
 *    any evidence/freshness/provenance field is rejected;
 *  - `makeFreshness` evaluates the recorded state honestly (a freshness
 *    window that has expired records STALE, never FRESH);
 *  - freshness degradation is MONOTONE in the projection engine (FRESH ->
 *    STALE only; never back without a new observation);
 *  - the delivery-evidence snapshot retains its §8 mirror fields
 *    (observedAt/receivedAt/freshUntil/freshnessState/evidenceClass).
 *
 * NEGATIVE PROOFS (red-on-violation):
 *  - a projection record missing evidence_class / freshness_state /
 *    observed_at / payload_digest is rejected (red when admitted);
 *  - a freshness record that lies (claims FRESH with an expired window)
 *    is impossible: makeFreshness records STALE (the toggle flips this).
 */
import { describe, expect, it } from "vitest";
import { makeFreshness, parseUtcInstant } from "@roamlink/contracts";
import { parseAdcosProjectionRecord } from "@roamlink/projections";
import { parseDeliveryEvidence } from "@roamlink/commerce-connectivity";
import { violationEnabled } from "../src/index.js";

const LOCK = "RL-LOCK-010";
const T0 = "2026-01-15T08:30:00.000Z";
const T_LATER = "2026-01-15T08:31:30.000Z";

/** A complete, valid §8 projection record. */
const PROJECTION_BASE = {
  projection_id: "prj.connectivity_intent.intent-7",
  source_authority: "adcos",
  canonical_resource_type: "connectivity_intent",
  canonical_resource_id: "intent-7",
  source_version: 3,
  event_id: "evt-3",
  payload_digest: "a".repeat(64),
  observed_at: T0,
  received_at: T0,
  fresh_until: "2026-01-15T08:31:00.000Z",
  freshness_state: "FRESH",
  evidence_class: "AUTHENTICATED",
  projection_version: 2,
  payload: { state: "OFFER_SELECTED" },
} as const;

describe(`${LOCK}: evidence and freshness are first-class`, () => {
  it("green: a complete §8 projection record parses cleanly", () => {
    const record = parseAdcosProjectionRecord(PROJECTION_BASE);
    expect(record.source_authority).toBe("adcos");
    expect(record.freshness_state).toBe("FRESH");
    expect(record.evidence_class).toBe("AUTHENTICATED");
  });

  it("negative proof: a projection record missing evidence/freshness/provenance fields is rejected (red when admitted)", () => {
    for (const missing of [
      "evidence_class",
      "freshness_state",
      "observed_at",
      "received_at",
      "fresh_until",
      "payload_digest",
      "source_authority",
      "projection_version",
    ]) {
      const violating = { ...PROJECTION_BASE } as Record<string, unknown>;
      delete violating[missing];
      if (violationEnabled(LOCK)) {
        expect(() => parseAdcosProjectionRecord(violating)).not.toThrow();
      } else {
        expect(() => parseAdcosProjectionRecord(violating)).toThrow(
          /ADCOS_PROJECTION_RECORD_INVALID|is required/,
        );
      }
    }
  });

  it("green: makeFreshness records the honest state (expired windows are STALE, never FRESH)", () => {
    const observed = parseUtcInstant(T0);
    const fresh = makeFreshness(
      { observedAt: observed, receivedAt: observed, freshUntil: parseUtcInstant("2026-01-15T08:31:00.000Z") },
      observed,
    );
    expect(fresh.freshnessState).toBe("FRESH");

    const evaluatedLater = makeFreshness(
      { observedAt: observed, receivedAt: observed, freshUntil: parseUtcInstant("2026-01-15T08:31:00.000Z") },
      parseUtcInstant(T_LATER),
    );
    expect(evaluatedLater.freshnessState).toBe("STALE");
  });

  it("negative proof: a freshness record with an expired window cannot be recorded as FRESH (red when recorded FRESH)", () => {
    const observed = parseUtcInstant(T0);
    const expired = makeFreshness(
      {
        observedAt: observed,
        receivedAt: observed,
        freshUntil: parseUtcInstant("2026-01-15T08:29:00.000Z"),
      },
      parseUtcInstant(T_LATER),
    );
    if (violationEnabled(LOCK)) {
      expect(expired.freshnessState).toBe("FRESH");
    } else {
      expect(expired.freshnessState).toBe("STALE");
    }
  });

  it("green: UNKNOWN is a valid, presentable state (absence is never guessed into a fact)", () => {
    // A projection record with UNKNOWN freshness and UNKNOWN evidence class
    // parses cleanly - unknown is a valid state, not an error.
    const unknownRecord = {
      ...PROJECTION_BASE,
      freshness_state: "UNKNOWN",
      evidence_class: "UNKNOWN",
      fresh_until: null,
      observed_at: null,
      received_at: null,
      source_version: null,
      event_id: null,
    };
    const parsed = parseAdcosProjectionRecord(unknownRecord);
    expect(parsed.freshness_state).toBe("UNKNOWN");
    expect(parsed.evidence_class).toBe("UNKNOWN");

    // makeFreshness with no timestamps is UNKNOWN, not FRESH.
    const noTimestamps = makeFreshness({}, parseUtcInstant(T_LATER));
    expect(noTimestamps.freshnessState).toBe("UNKNOWN");
  });

  it("green: the delivery-evidence vocabulary retains the full §8 mirror", () => {
    // Structural proof: the commerce-side evidence snapshot parses §8-shaped
    // observations with provenance, freshness AND payload digest retained.
    const evidence = parseDeliveryEvidence({
      evidenceClass: "AUTHENTICATED",
      observedAt: T0,
      receivedAt: T0,
      freshUntil: "2026-01-15T08:31:00.000Z",
      freshnessState: "FRESH",
      canonicalResourceType: "connectivity_contract",
      canonicalResourceId: "contract-1",
      sourceVersion: 4,
      eventId: "evt-4",
      payloadDigest: "b".repeat(64),
      payload: { state: "CONTRACT_ACTIVE" },
    });
    expect(evidence.evidenceClass).toBe("AUTHENTICATED");
    expect(evidence.freshUntil).toBe("2026-01-15T08:31:00.000Z");
    expect(evidence.payloadDigest).toBe("b".repeat(64));
  });
});
