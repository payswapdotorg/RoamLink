import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import {
  parseAdcosActivationRequest,
  parseAdcosIntentRequest,
  parseAdcosLeaseRenewal,
  parseAdcosLeaseRequest,
  parseAdcosLeaseRevocation,
  parseAdcosOfferSelection,
  parseAdcosTerminationRequest,
  parseAdcosWebhookEndpointRequest,
} from "../src/index.js";

const T0 = "2026-10-01T00:00:00.000Z";

const VALID_INTENT_REQUEST = {
  requirements: [{ kind: "locality", value: "ghana" }],
  validity: { from: T0 },
  termination: { policy: "auto" },
  recorded_at: T0,
};

describe("intent_request schema (RL-030, closed: exactly the v2 fields)", () => {
  it("parses the 4 required fields", () => {
    const parsed = parseAdcosIntentRequest(VALID_INTENT_REQUEST);
    expect(parsed.requirements).toEqual([{ kind: "locality", value: "ghana" }]);
    expect(parsed.validity).toEqual({ from: T0 });
    expect(parsed.termination).toEqual({ policy: "auto" });
    expect(parsed.recorded_at).toBe(T0);
    expect(Object.keys(parsed).sort()).toEqual([
      "recorded_at",
      "requirements",
      "termination",
      "validity",
    ]);
  });

  it("accepts all 7 optional fields when present", () => {
    const parsed = parseAdcosIntentRequest({
      ...VALID_INTENT_REQUEST,
      hard_constraints: ["no-roaming"],
      beneficiaries: ["user-1"],
      service_properties: { privacy: "high" },
      usage_pricing_terms: [{ model: "per-gb" }],
      assurance_obligations: ["latency-sla"],
      execution_scope: { devices: ["device-1"] },
      superseded_contract: "contract-9",
    });
    expect(parsed.hard_constraints).toEqual(["no-roaming"]);
    expect(parsed.superseded_contract).toBe("contract-9");
    expect(Object.keys(parsed)).toHaveLength(11);
  });

  it("rejects each missing required field", () => {
    for (const field of ["requirements", "validity", "termination", "recorded_at"]) {
      const input = { ...VALID_INTENT_REQUEST } as Record<string, unknown>;
      delete input[field];
      expect(() => parseAdcosIntentRequest(input)).toThrow(ValidationError);
    }
  });

  it("rejects unknown fields (closed schema)", () => {
    expect(() => parseAdcosIntentRequest({ ...VALID_INTENT_REQUEST, extra: true })).toThrow(
      ValidationError,
    );
  });

  it("rejects wrong field types (list/mapping/instant)", () => {
    expect(() =>
      parseAdcosIntentRequest({ ...VALID_INTENT_REQUEST, requirements: "not-a-list" }),
    ).toThrow(ValidationError);
    expect(() =>
      parseAdcosIntentRequest({ ...VALID_INTENT_REQUEST, validity: ["not-a-mapping"] }),
    ).toThrow(ValidationError);
    expect(() =>
      parseAdcosIntentRequest({ ...VALID_INTENT_REQUEST, recorded_at: "2026-10-01" }),
    ).toThrow(ValidationError);
    expect(() =>
      parseAdcosIntentRequest({ ...VALID_INTENT_REQUEST, superseded_contract: "bad ref!" }),
    ).toThrow(ValidationError);
  });
});

describe("offer_selection schema (RL-030, closed)", () => {
  it("requires offers (list) and recorded_at (instant)", () => {
    const parsed = parseAdcosOfferSelection({ offers: ["offer-1", "offer-2"], recorded_at: T0 });
    expect(parsed.offers).toEqual(["offer-1", "offer-2"]);
    expect(parsed.recorded_at).toBe(T0);
    expect(() => parseAdcosOfferSelection({ offers: ["offer-1"] })).toThrow(ValidationError);
    expect(() => parseAdcosOfferSelection({ recorded_at: T0 })).toThrow(ValidationError);
    expect(() => parseAdcosOfferSelection({ offers: [], recorded_at: T0, extra: 1 })).toThrow(
      ValidationError,
    );
    expect(() => parseAdcosOfferSelection({ offers: {}, recorded_at: T0 })).toThrow(ValidationError);
  });
});

describe("activation_request schema (RL-030, closed)", () => {
  it("requires activated_at and signature_refs", () => {
    const parsed = parseAdcosActivationRequest({
      activated_at: T0,
      signature_refs: ["sig-1", "sig-2"],
    });
    expect(parsed.activated_at).toBe(T0);
    expect(parsed.signature_refs).toHaveLength(2);
    expect(() => parseAdcosActivationRequest({ activated_at: T0 })).toThrow(ValidationError);
    expect(() => parseAdcosActivationRequest({ signature_refs: ["sig-1"] })).toThrow(ValidationError);
    expect(() =>
      parseAdcosActivationRequest({ activated_at: T0, signature_refs: ["bad sig"], extra: 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      parseAdcosActivationRequest({ activated_at: "nope", signature_refs: ["sig-1"] }),
    ).toThrow(ValidationError);
  });
});

describe("termination_request schema (RL-030, closed, literal field names)", () => {
  it("requires condition, recorded_reason and instant", () => {
    const parsed = parseAdcosTerminationRequest({
      condition: "customer-requested",
      recorded_reason: "user cancelled the trip",
      instant: T0,
    });
    expect(parsed.condition).toBe("customer-requested");
    expect(parsed.recorded_reason).toBe("user cancelled the trip");
    expect(parsed.instant).toBe(T0);
    expect(() =>
      parseAdcosTerminationRequest({ condition: "x", recorded_reason: "y" }),
    ).toThrow(ValidationError);
    expect(() => parseAdcosTerminationRequest({ condition: "x", instant: T0 })).toThrow(
      ValidationError,
    );
    expect(() => parseAdcosTerminationRequest({ recorded_reason: "y", instant: T0 })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseAdcosTerminationRequest({
        condition: "x",
        recorded_reason: "y",
        instant: T0,
        unknown: true,
      }),
    ).toThrow(ValidationError);
  });
});

describe("lease request schemas (RL-030, open: granted_at pinned, rest tolerated)", () => {
  it("requires granted_at; additional fields tolerated (facts incomplete)", () => {
    const parsed = parseAdcosLeaseRequest({ granted_at: T0 });
    expect(parsed.granted_at).toBe(T0);
    const extended = parseAdcosLeaseRequest({ granted_at: T0, duration: "48h", note: "x" });
    expect(extended.granted_at).toBe(T0);
    expect(() => parseAdcosLeaseRequest({})).toThrow(ValidationError);
    expect(() => parseAdcosLeaseRequest({ granted_at: "2026-10-01" })).toThrow(ValidationError);
    // the renewal request shares the pinned shape
    const renewal = parseAdcosLeaseRenewal({ granted_at: T0, extension_hours: 24 });
    expect(renewal.granted_at).toBe(T0);
    expect(() => parseAdcosLeaseRenewal({})).toThrow(ValidationError);
  });
});

describe("lease_revocation / webhook_endpoint schemas (RL-030, fully open)", () => {
  it("accepts any JSON object; rejects non-objects", () => {
    expect(() => parseAdcosLeaseRevocation({})).not.toThrow();
    expect(() => parseAdcosLeaseRevocation({ reason: "done", at: T0 })).not.toThrow();
    expect(() => parseAdcosLeaseRevocation([])).toThrow(ValidationError);
    expect(() => parseAdcosLeaseRevocation(null)).toThrow(ValidationError);
    expect(() => parseAdcosWebhookEndpointRequest({})).not.toThrow();
    expect(() =>
      parseAdcosWebhookEndpointRequest({ url: "https://example.test/hook", events: ["x"] }),
    ).not.toThrow();
    expect(() => parseAdcosWebhookEndpointRequest("nope")).toThrow(ValidationError);
  });
});
