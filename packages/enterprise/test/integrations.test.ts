/**
 * Enterprise integration status read record tests (PA-008, closes
 * RL-115-F5).
 *
 * Proves the READ-ONLY record's honest-state contract: the closed kind and
 * four-state vocabularies, the fail-closed parse (unknown fields, version
 * gate, out-of-vocabulary values), the state invariants (a `configured`
 * assertion carries its summary and rests on a COMPLETE observation; an
 * `unavailable` record is a contract declaration carrying NO observation —
 * the missing backend contract is never dressed up as an observed state;
 * absence states carry no integration content), and that the record exposes
 * NO write path (RL-LOCK-003/004/005: RoamLink never fabricates integration
 * configuration capability — the module owns no command, OAuth/SCIM/MDM
 * flow, transition map or editor).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";

import {
  ENTERPRISE_INTEGRATION_KINDS,
  ENTERPRISE_INTEGRATION_STATES,
  isEnterpriseIntegrationKind,
  isEnterpriseIntegrationState,
  parseEnterpriseIntegrationStatusRecord,
} from "../src/integrations.js";

const AT = "2026-02-01T10:00:00.000Z";
const INTEGRATION_ID = "00000000-0000-4000-8000-0000000000f8";
const TENANT = "org:00000000-0000-4000-8000-0000000000aa";

function configuredRecord(freshnessState: "FRESH" | "STALE" = "FRESH") {
  return parseEnterpriseIntegrationStatusRecord({
    integrationId: INTEGRATION_ID,
    contractVersion: "0.1",
    tenantId: TENANT,
    kind: "sso",
    state: "configured",
    summary: "Sign in through your organization's identity provider.",
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

describe("the enterprise integration status read record (PA-008, RL-115-F5)", () => {
  it("parses a configured record with its facts, frozen", () => {
    const record = configuredRecord();
    expect(record.kind).toBe("sso");
    expect(record.state).toBe("configured");
    expect(record.summary).toBe("Sign in through your organization's identity provider.");
    expect(record.freshness.freshnessState).toBe("FRESH");
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("parses the honest absence states (not-configured / unknown), separate and explicit", () => {
    const notConfigured = parseEnterpriseIntegrationStatusRecord({
      integrationId: INTEGRATION_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      kind: "scim",
      state: "not-configured",
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

    const unknown = parseEnterpriseIntegrationStatusRecord({
      integrationId: INTEGRATION_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      kind: "mdm",
      state: "unknown",
      freshness: { observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "UNKNOWN" },
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    });
    expect(unknown.state).toBe("unknown");
    expect(unknown.freshness.freshnessState).toBe("UNKNOWN");
  });

  it("parses the unavailable declaration: the missing backend contract, honest and observation-free", () => {
    // `unavailable` is the F5 closure contract's honest state: the
    // enterprise integration API exposes NO status read for the kind. The
    // record declares exactly that - carrying no observation (UNKNOWN
    // freshness) and no integration content, never a fabricated status.
    const unavailable = parseEnterpriseIntegrationStatusRecord({
      integrationId: INTEGRATION_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      kind: "scim",
      state: "unavailable",
      freshness: { observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "UNKNOWN" },
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    });
    expect(unavailable.state).toBe("unavailable");
    expect("summary" in unavailable).toBe(false);
    expect(unavailable.freshness.freshnessState).toBe("UNKNOWN");
  });

  it("keeps the kind and state vocabularies closed", () => {
    expect(ENTERPRISE_INTEGRATION_KINDS).toEqual(["sso", "scim", "mdm"]);
    expect(ENTERPRISE_INTEGRATION_STATES).toEqual([
      "configured",
      "not-configured",
      "unavailable",
      "unknown",
    ]);
    expect(isEnterpriseIntegrationKind("sso")).toBe(true);
    expect(isEnterpriseIntegrationKind("oauth")).toBe(false);
    expect(isEnterpriseIntegrationState("unavailable")).toBe(true);
    expect(isEnterpriseIntegrationState("disabled")).toBe(false);
  });

  it("fails closed on unknown fields, bad ids and out-of-vocabulary values", () => {
    const base = {
      integrationId: INTEGRATION_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      kind: "sso",
      state: "unknown",
      freshness: { observedAt: null, receivedAt: null, freshUntil: null, freshnessState: "UNKNOWN" },
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    };
    expect(() => parseEnterpriseIntegrationStatusRecord({ ...base, extra: true })).toThrowError(
      ValidationError,
    );
    expect(() =>
      parseEnterpriseIntegrationStatusRecord({ ...base, integrationId: "not-a-uuid" }),
    ).toThrowError(ValidationError);
    expect(() => parseEnterpriseIntegrationStatusRecord({ ...base, kind: "ldap" })).toThrowError(
      ValidationError,
    );
    expect(() => parseEnterpriseIntegrationStatusRecord({ ...base, state: "active" })).toThrowError(
      ValidationError,
    );
    expect(() =>
      parseEnterpriseIntegrationStatusRecord({ ...base, contractVersion: "9.1" }),
    ).toThrowError(ValidationError);
  });

  it("a configured assertion must carry its summary (fail-closed on doctored records)", () => {
    const base = {
      integrationId: INTEGRATION_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      kind: "sso",
      state: "configured",
      summary: "Sign in through your organization's identity provider.",
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
    expect(() => parseEnterpriseIntegrationStatusRecord({ ...base, summary: undefined })).toThrowError(
      ValidationError,
    );
    expect(() =>
      parseEnterpriseIntegrationStatusRecord({ ...base, summary: "  untrimmed  " }),
    ).toThrowError(ValidationError);
  });

  it("a non-configured state carries no integration content (never a collapsed absence)", () => {
    const base = {
      integrationId: INTEGRATION_ID,
      contractVersion: "0.1",
      tenantId: TENANT,
      kind: "mdm",
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
    for (const state of ["not-configured", "unavailable"] as const) {
      expect(() =>
        parseEnterpriseIntegrationStatusRecord({ ...base, state, summary: "a summary" }),
      ).toThrowError(ValidationError);
    }
  });

  it("an assertion rests on a complete observation; unavailable and unknown carry none", () => {
    const complete = {
      observedAt: AT,
      receivedAt: AT,
      freshUntil: "2026-02-01T12:00:00.000Z",
    };
    const incomplete = { observedAt: null, receivedAt: null, freshUntil: null };
    // An assertion state with an incomplete observation fails closed...
    expect(() =>
      parseEnterpriseIntegrationStatusRecord({
        integrationId: INTEGRATION_ID,
        contractVersion: "0.1",
        tenantId: TENANT,
        kind: "scim",
        state: "not-configured",
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
      parseEnterpriseIntegrationStatusRecord({
        integrationId: INTEGRATION_ID,
        contractVersion: "0.1",
        tenantId: TENANT,
        kind: "sso",
        state: "configured",
        summary: "Sign in through your organization's identity provider.",
        freshness: { ...complete, freshnessState: "UNKNOWN" },
        createdAt: AT,
        updatedAt: AT,
        revision: 1,
      }),
    ).toThrowError(ValidationError);
    expect(() =>
      parseEnterpriseIntegrationStatusRecord({
        integrationId: INTEGRATION_ID,
        contractVersion: "0.1",
        tenantId: TENANT,
        kind: "mdm",
        state: "unavailable",
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

  it("the module owns no integration write path (read-only by construction)", async () => {
    // The authority fence: the integrations module exports parse +
    // vocabularies ONLY - no command applier, no OAuth/SCIM/MDM flow, no
    // transition map, no editor. Enterprise integrations are
    // organization-level configuration managed upstream; importing the
    // module must not surface any write machinery (RL-LOCK-003/004/005).
    // (Type-only exports are invisible at runtime, so this pins the
    // runtime surface exactly.)
    const module = await import("../src/integrations.js");
    const exported = Object.keys(module).sort();
    expect(exported).toEqual(
      [
        "ENTERPRISE_INTEGRATION_KINDS",
        "ENTERPRISE_INTEGRATION_STATES",
        "isEnterpriseIntegrationKind",
        "isEnterpriseIntegrationState",
        "parseEnterpriseIntegrationStatusRecord",
      ].sort(),
    );
    for (const name of exported) {
      expect(name, "no write-path export").not.toMatch(/apply|command|transition|create|update|edit|write|enroll|provision/i);
    }
  });
});
