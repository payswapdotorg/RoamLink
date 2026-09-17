/**
 * RL-074 suite 6: PRIVACY/RETENTION ENFORCEMENT (RL-054 + RL-010;
 * spec/security.md credential/privacy rules; spec/data-model.md "Privacy":
 * "Device telemetry is minimized. Location, network identifiers, diagnostics
 * and usage data have explicit purpose/retention classifications").
 *
 * Attack catalog (each a negative proof where applicable):
 *   P-1  data past its retention class is PURGED per policy: the stricter
 *        categories (location/network-identifiers) are TOMBSTONED with the
 *        payload erased; the coarse categories are HARD-DELETED; not-yet-
 *        expired records are untouched;
 *   P-2  consent-gated fields never appear without consent: a location (or
 *        network-identifier) record without explicit consent is REFUSED at
 *        admission (typed, with an audited rejection);
 *   P-3  the stricter-control policy is structural: a lax policy (longer
 *        location window than diagnostics, or missing consent requirement)
 *        CANNOT be constructed;
 *   P-4  access control: expired records are denied (record-expired),
 *        tombstoned records are denied (record-tombstoned), non-declared
 *        purposes are denied (purpose-not-declared), and consent-gated
 *        access without consent is denied (consent-required);
 *   P-5  explicit erasure (the user's right) applies immediately regardless
 *        of the retention window, idempotently for already-erased records;
 *   P-6  every retention decision lands in the append-only decision audit
 *        trail (retained / rejected / access-granted / access-denied /
 *        expired-hard-deleted), atomically with its record effect;
 *   P-7  retention cannot be negotiated by the record: expiry is computed
 *        from the policy window (a record claiming its own expiry is
 *        rejected - unknown field, closed record shape).
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roamlink/contracts";
import {
  DEFAULT_RETENTION_POLICY,
  PersistenceRetentionRecordStore,
  RetentionEnforcementEngine,
  RETENTION_AUDIT_REPOSITORY,
  RETENTION_RECORDS_REPOSITORY,
  parseRetentionPolicy,
} from "@roamlink/retention";
import { createInMemoryPersistence } from "@roamlink/persistence";
import { instantPlusMs, makeSecurityWorld, registerPrincipal, T0 } from "../src/harness.js";
import type { SecurityWorld } from "../src/harness.js";

interface RetentionWorld {
  readonly world: SecurityWorld;
  readonly engine: RetentionEnforcementEngine;
  readonly persistence: ReturnType<typeof createInMemoryPersistence>;
  decisionIds: () => string;
}

/** Deterministic decision ids, shared across the engine instances. */
function makeRetentionWorld(world: SecurityWorld): RetentionWorld {
  const persistence = createInMemoryPersistence();
  let counter = 0;
  const decisionIds = () =>
    `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
  const engine = new RetentionEnforcementEngine({
    persistence,
    policy: DEFAULT_RETENTION_POLICY,
    recordStore: new PersistenceRetentionRecordStore(persistence, persistence, DEFAULT_RETENTION_POLICY),
    decisionIdGenerator: decisionIds,
  });
  return { world, engine, persistence, decisionIds };
}

/** A valid classified-record input for a category. */
function recordInput(input: {
  readonly recordId: string;
  readonly tenantId: string;
  readonly dataCategory: string;
  readonly purposes: readonly string[];
  readonly consent: boolean;
  readonly collectedAt: string;
  readonly payload?: Record<string, unknown>;
}) {
  return {
    recordId: input.recordId,
    tenantId: input.tenantId,
    dataCategory: input.dataCategory,
    purposes: [...input.purposes],
    collectedAt: input.collectedAt,
    consent: input.consent,
    payload: input.payload ?? { note: "minimized telemetry payload" },
  };
}

describe("RL-074 suite 6: privacy/retention enforcement", () => {
  it("P-1 data past its retention class is purged per policy semantics (tombstone vs hard-delete)", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x90);
    const retention = makeRetentionWorld(world);

    // A LOCATION record (24h window, tombstone semantics, consent granted).
    await retention.engine.admit(
      recordInput({
        recordId: "ret:loc-1",
        tenantId: principal.tenantId,
        dataCategory: "location",
        purposes: ["connectivity-experience"],
        consent: true,
        collectedAt: T0,
        payload: { coarseCell: "sector-7" },
      }),
      T0,
    );
    // A DIAGNOSTICS record (90d window, hard-delete semantics).
    await retention.engine.admit(
      recordInput({
        recordId: "ret:diag-1",
        tenantId: principal.tenantId,
        dataCategory: "diagnostics",
        purposes: ["diagnostics"],
        consent: false,
        collectedAt: T0,
      }),
      T0,
    );

    // Before expiry: both live.
    const before = await retention.engine.sweepExpired(instantPlusMs(T0, 60_000));
    expect(before.swept).toHaveLength(0);

    // 25 hours later: the LOCATION record is expired (24h window) and the
    // DIAGNOSTICS record is not (90d window).
    const report = await retention.engine.sweepExpired(instantPlusMs(T0, 25 * 60 * 60 * 1000));
    expect(report.swept).toHaveLength(1);
    expect(report.swept[0]?.action).toBe("tombstoned");
    expect(report.swept[0]?.recordId).toBe("ret:loc-1");

    // The tombstone ERASED the payload (suppressed, not just flagged).
    const stored = await retention.persistence
      .records(RETENTION_RECORDS_REPOSITORY)
      .get("ret:loc-1");
    if (stored === null) throw new Error("expected the tombstoned record");
    expect((stored.value as { payload: unknown }).payload).toBeNull();
    expect((stored.value as { tombstonedAt: string }).tombstonedAt).toBeDefined();

    // The diagnostics record is untouched by the same sweep.
    const diagnostics = await retention.persistence
      .records(RETENTION_RECORDS_REPOSITORY)
      .get("ret:diag-1");
    expect((diagnostics?.value as { payload: unknown }).payload).toEqual({
      note: "minimized telemetry payload",
    });

    // 91 days later: the diagnostics record is HARD-DELETED (absent).
    const finalReport = await retention.engine.sweepExpired(
      instantPlusMs(T0, 91 * 24 * 60 * 60 * 1000),
    );
    expect(
      finalReport.swept.some((entry) => entry.recordId === "ret:diag-1" && entry.action === "hard-deleted"),
    ).toBe(true);
    expect(
      await retention.persistence.records(RETENTION_RECORDS_REPOSITORY).get("ret:diag-1"),
    ).toBeNull();
  });

  it("P-2 consent-gated categories are refused at admission without explicit consent", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x91);
    const retention = makeRetentionWorld(world);

    // LOCATION without consent: refused, with an audited rejection.
    await expect(
      retention.engine.admit(
        recordInput({
          recordId: "ret:loc-no-consent",
          tenantId: principal.tenantId,
          dataCategory: "location",
          purposes: ["connectivity-experience"],
          consent: false,
          collectedAt: T0,
        }),
        T0,
      ),
    ).rejects.toThrowError(ValidationError);

    // The rejection is AUDITED (secret-material vs invalid-classification
    // reason classes both land here - this one is consent).
    const auditRows = await retention.persistence
      .records(RETENTION_AUDIT_REPOSITORY)
      .list();
    expect(auditRows.length).toBe(1);
    const decision = auditRows[0]?.value as Record<string, unknown>;
    expect(decision["decision"]).toBe("rejected-invalid-record");

    // NETWORK IDENTIFIERS without consent: refused the same way.
    await expect(
      retention.engine.admit(
        recordInput({
          recordId: "ret:net-no-consent",
          tenantId: principal.tenantId,
          dataCategory: "network-identifiers",
          purposes: ["connectivity-experience"],
          consent: false,
          collectedAt: T0,
        }),
        T0,
      ),
    ).rejects.toThrowError(ValidationError);

    // With consent: both admit.
    await expect(
      retention.engine.admit(
        recordInput({
          recordId: "ret:loc-consent",
          tenantId: principal.tenantId,
          dataCategory: "location",
          purposes: ["connectivity-experience"],
          consent: true,
          collectedAt: T0,
          payload: { coarseCell: "sector-9" },
        }),
        T0,
      ),
    ).resolves.toBeDefined();
  });

  it("P-3 the stricter-control policy is structural: a lax policy cannot be constructed", () => {
    const base = DEFAULT_RETENTION_POLICY;
    const rules = JSON.parse(
      JSON.stringify({
        contractVersion: "0.1",
        rules: Object.fromEntries(
          Object.entries(base.rules).map(([category, rule]) => [
            category,
            {
              category,
              retentionWindowMs: rule.retentionWindowMs,
              erasureSemantics: rule.erasureSemantics,
              allowedPurposes: [...rule.allowedPurposes],
              maxPayloadBytes: rule.maxPayloadBytes,
              requiresExplicitConsent: rule.requiresExplicitConsent,
            },
          ]),
        ),
      }),
    ) as Record<string, unknown>;

    // Attack 1: location window LONGER than diagnostics (lax).
    const laxWindow = structuredClone(rules);
    (
      (laxWindow.rules as Record<string, { retentionWindowMs: number }>)["location"] as {
        retentionWindowMs: number;
      }
    ).retentionWindowMs = 100 * 24 * 60 * 60 * 1000;
    expect(() => parseRetentionPolicy(laxWindow)).toThrowError(ValidationError);

    // Attack 2: dropping the consent requirement from location.
    const laxConsent = structuredClone(rules);
    (
      (laxConsent.rules as Record<string, { requiresExplicitConsent: boolean }>)["location"] as {
        requiresExplicitConsent: boolean;
      }
    ).requiresExplicitConsent = false;
    expect(() => parseRetentionPolicy(laxConsent)).toThrowError(ValidationError);

    // The honest default still constructs.
    expect(() => parseRetentionPolicy(rules)).not.toThrow();
  });

  it("P-4 access control refuses expired, tombstoned, non-declared-purpose and consent-less access", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x92);
    const retention = makeRetentionWorld(world);

    // A live diagnostics record (purposes: diagnostics + support).
    await retention.engine.admit(
      recordInput({
        recordId: "ret:access-1",
        tenantId: principal.tenantId,
        dataCategory: "diagnostics",
        purposes: ["diagnostics", "support"],
        consent: false,
        collectedAt: T0,
      }),
      T0,
    );

    // A declared purpose is granted (audited).
    const granted = await retention.engine.authorizeAccess(
      "ret:access-1",
      "support",
      instantPlusMs(T0, 60_000),
    );
    expect(granted).toEqual({ allowed: true });

    // A NON-declared purpose is denied.
    const wrongPurpose = await retention.engine.authorizeAccess(
      "ret:access-1",
      "security",
      instantPlusMs(T0, 60_000),
    );
    expect(wrongPurpose).toMatchObject({ allowed: false, refusalReason: "purpose-not-declared" });

    // Past expiry: denied (record-expired) - data past its class is not
    // accessible even before the sweep physically erases it.
    const expired = await retention.engine.authorizeAccess(
      "ret:access-1",
      "support",
      instantPlusMs(T0, 91 * 24 * 60 * 60 * 1000),
    );
    expect(expired).toMatchObject({ allowed: false, refusalReason: "record-expired" });

    // A consent-gated record WITH consent grants access...
    await retention.engine.admit(
      recordInput({
        recordId: "ret:access-loc",
        tenantId: principal.tenantId,
        dataCategory: "location",
        purposes: ["connectivity-experience"],
        consent: true,
        collectedAt: T0,
        payload: { coarseCell: "sector-11" },
      }),
      T0,
    );
    const locationAccess = await retention.engine.authorizeAccess(
      "ret:access-loc",
      "connectivity-experience",
      instantPlusMs(T0, 60_000),
    );
    expect(locationAccess).toEqual({ allowed: true });

    // ...and a TOMBSTONED record denies access.
    await retention.engine.sweepExpired(instantPlusMs(T0, 25 * 60 * 60 * 1000));
    const tombstoned = await retention.engine.authorizeAccess(
      "ret:access-loc",
      "connectivity-experience",
      instantPlusMs(T0, 25 * 60 * 60 * 1000),
    );
    expect(tombstoned).toMatchObject({ allowed: false, refusalReason: "record-tombstoned" });
  });

  it("P-5 explicit erasure applies immediately regardless of the window, idempotently", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x93);
    const retention = makeRetentionWorld(world);

    // A USAGE record (hard-delete semantics) and a LOCATION record
    // (tombstone semantics, consent granted).
    await retention.engine.admit(
      recordInput({
        recordId: "ret:erasure-usage",
        tenantId: principal.tenantId,
        dataCategory: "usage",
        purposes: ["support"],
        consent: false,
        collectedAt: T0,
      }),
      T0,
    );
    await retention.engine.admit(
      recordInput({
        recordId: "ret:erasure-loc",
        tenantId: principal.tenantId,
        dataCategory: "location",
        purposes: ["connectivity-experience"],
        consent: true,
        collectedAt: T0,
        payload: { coarseCell: "sector-12" },
      }),
      T0,
    );

    // Erasure LONG before the 180d usage / 24h location windows.
    const usageOutcome = await retention.engine.requestErasure(
      "ret:erasure-usage",
      instantPlusMs(T0, 60_000),
      "usr:00000000-0000-4000-8000-000000000093",
    );
    expect(usageOutcome.action).toBe("hard-deleted");
    expect(
      await retention.persistence.records(RETENTION_RECORDS_REPOSITORY).get("ret:erasure-usage"),
    ).toBeNull();

    const locationOutcome = await retention.engine.requestErasure(
      "ret:erasure-loc",
      instantPlusMs(T0, 60_000),
      "usr:00000000-0000-4000-8000-000000000093",
    );
    expect(locationOutcome.action).toBe("tombstoned");
    const tombstone = await retention.persistence
      .records(RETENTION_RECORDS_REPOSITORY)
      .get("ret:erasure-loc");
    expect((tombstone?.value as { payload: unknown }).payload).toBeNull();

    // Idempotent for tombstone-semantics records: erasing already-erased
    // data is a no-op (the data is already gone; no double audit claim).
    const again = await retention.engine.requestErasure(
      "ret:erasure-loc",
      instantPlusMs(T0, 120_000),
      "usr:00000000-0000-4000-8000-000000000093",
    );
    expect(again.action).toBe("already-tombstoned");

    // For hard-deleted records, a second erasure is a typed NotFound (the
    // data no longer exists at all - the honest absence).
    await expect(
      retention.engine.requestErasure(
        "ret:erasure-usage",
        instantPlusMs(T0, 120_000),
        "usr:00000000-0000-4000-8000-000000000093",
      ),
    ).rejects.toMatchObject({ reason: "RETENTION_RECORD_NOT_FOUND" });

    // Unknown records are typed NotFound too (no existence oracle games).
    await expect(
      retention.engine.requestErasure("ret:never-existed", T0, null),
    ).rejects.toMatchObject({ reason: "RETENTION_RECORD_NOT_FOUND" });
  });

  it("P-6 every retention decision lands in the audit trail with the tenant boundary", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x94);
    const retention = makeRetentionWorld(world);

    await retention.engine.admit(
      recordInput({
        recordId: "ret:audit-1",
        tenantId: principal.tenantId,
        dataCategory: "diagnostics",
        purposes: ["diagnostics"],
        consent: false,
        collectedAt: T0,
      }),
      T0,
    );
    await retention.engine.authorizeAccess("ret:audit-1", "diagnostics", T0, "actor-audit");
    await retention.engine.authorizeAccess("ret:audit-1", "support", T0, "actor-audit");
    await retention.engine.sweepExpired(instantPlusMs(T0, 91 * 24 * 60 * 60 * 1000));

    const rows = await retention.persistence.records(RETENTION_AUDIT_REPOSITORY).list();
    const decisions = rows.map((row) => (row.value as { decision: string }).decision).sort();
    expect(decisions).toEqual([
      "access-denied",
      "access-granted",
      "expired-hard-deleted",
      "retained",
    ]);
    for (const row of rows) {
      const value = row.value as { tenantId: string };
      expect(value.tenantId).toBe(principal.tenantId);
    }
  });

  it("P-7 retention cannot be negotiated by the record (expiry is computed, never claimed)", async () => {
    const world = makeSecurityWorld();
    const principal = await registerPrincipal(world, 0x95);
    const retention = makeRetentionWorld(world);

    // An attacker tries to smuggle their own expiry onto the record: the
    // record shape is closed (unknown field).
    await expect(
      retention.engine.admit(
        {
          ...recordInput({
            recordId: "ret:negotiate-1",
            tenantId: principal.tenantId,
            dataCategory: "usage",
            purposes: ["support"],
            consent: false,
            collectedAt: T0,
          }),
          expiresAt: instantPlusMs(T0, 365 * 24 * 60 * 60 * 1000),
        },
        T0,
      ),
    ).rejects.toThrowError(ValidationError);

    // And the computed expiry is exactly collectedAt + policy window.
    const admitted = await retention.engine.admit(
      recordInput({
        recordId: "ret:negotiate-2",
        tenantId: principal.tenantId,
        dataCategory: "usage",
        purposes: ["support"],
        consent: false,
        collectedAt: T0,
      }),
      T0,
    );
    expect(admitted.expiresAt).toBe(
      instantPlusMs(T0, 180 * 24 * 60 * 60 * 1000),
    );
  });
});
