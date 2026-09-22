/**
 * Organization policy read record tests (PA-007, closes RL-115-F7).
 *
 * Proves the READ-ONLY record's honest-absence contract: the closed state
 * and source vocabularies, the fail-closed parse (unknown fields, version
 * gate, out-of-vocabulary values), the state invariants (a `configured`
 * assertion carries its facts; absence states carry no policy content; an
 * assertion rests on a COMPLETE observation - an incomplete one forces the
 * honest `unknown` state), and that the record exposes NO write path
 * (RL-LOCK-003/004/005: RoamLink never duplicates connectivity policy
 * authority - the module owns no command, transition map or editor).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";

import {
  isOrganizationPolicySource,
  isOrganizationPolicyState,
  ORGANIZATION_POLICY_SOURCES,
  ORGANIZATION_POLICY_STATES,
  parseOrganizationPolicyRecord,
} from "../src/policy.js";

const AT = "2026-02-01T10:00:00.000Z";
const POLICY_ID = "00000000-0000-4000-8000-0000000000f7";
const TENANT = "org:00000000-0000-4000-8000-0000000000aa";

function configuredRecord(freshnessState: "FRESH" | "STALE" = "FRESH") {
  return parseOrganizationPolicyRecord({
    policyId: POLICY_ID,
    contractVersion: "0.1",
    tenantId: TENANT,
    state: "configured",
    source: "organization-administration",
    policyVersion: "2026-02",
    summary: "Roam on approved networks with a capped daily spend.",
    effectiveAt: AT,
    freshness: {
      observedAt: AT,
      receivedAt: AT,
      freshUntil: freshnessState === "FRESH" ? "2026-02-01T12:00:00.000Z" : "2026-02-01T09:00:00.000Z",
      freshnessState,
    },
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
  });
}

describe("the organization policy read record (PA-007, RL-115-F7)", () => {
  it("parses a configured record with its facts, frozen", () => {
    const record = configuredRecord();
    expect(record.state).toBe("configured");
    expect(record.source).toBe("organization-administration");
    expect(record.policyVersion).toBe("2026-02");
    expect(record.summary).toBe("Roam on approved networks with a capped daily spend.");
    expect(record.effectiveAt).toBe(AT);
    expect(record.freshness.freshnessState).toBe("FRESH");
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("parses the honest absence states (not-configured / unknown), separate and explicit", () => {
    const notConfigured = parseOrganizationPolicyRecord({
      policyId: POLICY_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      state: "not-configured",
      source: "organization-administration",
      freshness: {
        observedAt: AT,
        receivedAt: AT,
        freshUntil: "2026-02-01T12:00:00.000Z",
        freshnessState: "FRESH",
      },
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    });
    expect(notConfigured.state).toBe("not-configured");
    expect("summary" in notConfigured).toBe(false);
    expect("policyVersion" in notConfigured).toBe(false);

    const unknown = parseOrganizationPolicyRecord({
      policyId: POLICY_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      state: "unknown",
      source: "organization-administration",
      freshness: { observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "UNKNOWN" },
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    });
    expect(unknown.state).toBe("unknown");
    expect(unknown.freshness.freshnessState).toBe("UNKNOWN");
  });

  it("keeps the state and source vocabularies closed", () => {
    expect(ORGANIZATION_POLICY_STATES).toEqual(["configured", "not-configured", "unknown"]);
    expect(ORGANIZATION_POLICY_SOURCES).toEqual(["organization-administration"]);
    expect(isOrganizationPolicyState("configured")).toBe(true);
    expect(isOrganizationPolicyState("failed")).toBe(false);
    expect(isOrganizationPolicySource("organization-administration")).toBe(true);
    expect(isOrganizationPolicySource("adcos-fabric")).toBe(false);
  });

  it("fails closed on unknown fields, bad ids and out-of-vocabulary values", () => {
    const base = {
      policyId: POLICY_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      state: "unknown",
      source: "organization-administration",
      freshness: { observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "UNKNOWN" },
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    };
    expect(() => parseOrganizationPolicyRecord({ ...base, extra: true })).toThrowError(ValidationError);
    expect(() => parseOrganizationPolicyRecord({ ...base, policyId: "not-a-uuid" })).toThrowError(
      ValidationError,
    );
    expect(() => parseOrganizationPolicyRecord({ ...base, state: "configured" })).toThrowError(
      ValidationError,
    );
    expect(() => parseOrganizationPolicyRecord({ ...base, state: "active" })).toThrowError(
      ValidationError,
    );
    expect(() => parseOrganizationPolicyRecord({ ...base, source: "adcos" })).toThrowError(
      ValidationError,
    );
    expect(() =>
      parseOrganizationPolicyRecord({ ...base, contractVersion: "9.1" }),
    ).toThrowError(ValidationError);
  });

  it("a configured assertion must carry its facts (fail-closed on doctored records)", () => {
    const base = {
      policyId: POLICY_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      state: "configured",
      source: "organization-administration",
      policyVersion: "2026-02",
      summary: "Roam on approved networks with a capped daily spend.",
      effectiveAt: AT,
      freshness: {
        observedAt: AT,
        receivedAt: AT,
        freshUntil: "2026-02-01T12:00:00.000Z",
        freshnessState: "FRESH",
      },
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    };
    expect(() => parseOrganizationPolicyRecord({ ...base, summary: undefined })).toThrowError(
      ValidationError,
    );
    expect(() => parseOrganizationPolicyRecord({ ...base, policyVersion: undefined })).toThrowError(
      ValidationError,
    );
    expect(() => parseOrganizationPolicyRecord({ ...base, effectiveAt: undefined })).toThrowError(
      ValidationError,
    );
    expect(() =>
      parseOrganizationPolicyRecord({ ...base, summary: "  untrimmed  " }),
    ).toThrowError(ValidationError);
  });

  it("an absence state carries no policy content (never a collapsed absence)", () => {
    const base = {
      policyId: POLICY_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      source: "organization-administration",
      freshness: {
        observedAt: AT,
        receivedAt: AT,
        freshUntil: "2026-02-01T12:00:00.000Z",
        freshnessState: "FRESH",
      },
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    };
    for (const state of ["not-configured", "unknown"] as const) {
      expect(() =>
        parseOrganizationPolicyRecord({ ...base, state, policyVersion: "2026-02" }),
      ).toThrowError(ValidationError);
      expect(() =>
        parseOrganizationPolicyRecord({ ...base, state, summary: "a summary" }),
      ).toThrowError(ValidationError);
      expect(() =>
        parseOrganizationPolicyRecord({ ...base, state, effectiveAt: AT }),
      ).toThrowError(ValidationError);
    }
  });

  it("an assertion rests on a complete observation; an incomplete one forces unknown", () => {
    const complete = {
      observedAt: AT,
      receivedAt: AT,
      freshUntil: "2026-02-01T12:00:00.000Z",
    };
    const incomplete = { observedAt: null, receivedAt: null, freshUntil: null };
    // An assertion state with an incomplete observation fails closed...
    expect(() =>
      parseOrganizationPolicyRecord({
        policyId: POLICY_ID,
        contractVersion: "0.1",
        tenantId: TENANT,
        state: "not-configured",
        source: "organization-administration",
        freshness: { ...incomplete, freshnessState: "UNKNOWN" },
        createdAt: AT,
        updatedAt: AT,
        revision: 1,
      }),
    ).toThrowError(ValidationError);
    // ...and a doctored freshness pairing fails closed both ways: a complete
    // observation never records UNKNOWN, an incomplete one never records
    // FRESH/STALE.
    expect(() =>
      parseOrganizationPolicyRecord({
        policyId: POLICY_ID,
        contractVersion: "0.1",
        tenantId: TENANT,
        state: "configured",
        source: "organization-administration",
        policyVersion: "2026-02",
        summary: "Roam on approved networks with a capped daily spend.",
        effectiveAt: AT,
        freshness: { ...complete, freshnessState: "UNKNOWN" },
        createdAt: AT,
        updatedAt: AT,
        revision: 1,
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      parseOrganizationPolicyRecord({
        policyId: POLICY_ID,
        contractVersion: "0.1",
        tenantId: TENANT,
        state: "unknown",
        source: "organization-administration",
        freshness: { ...incomplete, freshnessState: "FRESH" },
        createdAt: AT,
        updatedAt: AT,
        revision: 1,
      }),
    ).toThrowError(ValidationError);
  });

  it("a stale-but-complete observation parses (the stale freshness pairing is a record state)", () => {
    const record = configuredRecord("STALE");
    expect(record.state).toBe("configured");
    expect(record.freshness.freshnessState).toBe("STALE");
  });

  it("the module owns no policy write path (read-only by construction)", async () => {
    // The authority fence: the policy module exports parse + vocabulary
    // ONLY - no command applier, no transition map, no editor. A policy is
    // organization-level configuration managed upstream; importing the
    // module must not surface any write machinery (RL-LOCK-003/004/005).
    // (Type-only exports are invisible at runtime, so this pins the
    // runtime surface exactly.)
    const module = await import("../src/policy.js");
    const exported = Object.keys(module).sort();
    expect(exported).toEqual(
      [
        "ORGANIZATION_POLICY_SOURCES",
        "ORGANIZATION_POLICY_STATES",
        "isOrganizationPolicySource",
        "isOrganizationPolicyState",
        "parseOrganizationPolicyRecord",
      ].sort(),
    );
    for (const name of exported) {
      expect(name, "no write-path export").not.toMatch(/apply|command|transition|create|update|edit|write/i);
    }
  });
});
